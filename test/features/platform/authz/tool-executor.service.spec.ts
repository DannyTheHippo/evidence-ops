import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import {
  TOOL_AUTHZ_HOOK,
  type ToolAuthzHook,
} from '../../../../src/features/platform/authz/authz-hook.interface';
import { ToolAlreadyRegisteredException } from '../../../../src/features/platform/authz/exceptions/authz.exception';
import { ToolExecutorService } from '../../../../src/features/platform/authz/tool-executor.service';
import type { ToolExecutionStep } from '../../../../src/features/platform/authz/types/tool-definition.type';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';

const STEP: ToolExecutionStep = { stepId: 'step-1', allowedTools: ['echo'] };

function buildEchoTool(handler = jest.fn().mockResolvedValue('ok')) {
  return {
    name: 'echo',
    argsSchema: z.object({ message: z.string().min(1) }),
    handler,
  };
}

describe('ToolExecutorService', () => {
  let service: ToolExecutorService;
  let mockAuthzHook: jest.Mocked<ToolAuthzHook>;
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    mockAuthzHook = { authorize: jest.fn().mockReturnValue({ allowed: true }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolExecutorService,
        { provide: TOOL_AUTHZ_HOOK, useValue: mockAuthzHook },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<ToolExecutorService>(ToolExecutorService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should refuse a call to a tool that was never registered', async () => {
    const result = await service.execute({ step: STEP, toolName: 'echo', rawArgs: {} });

    expect(result).toEqual({
      kind: 'refused',
      reason: 'tool-not-registered',
      detail: "tool 'echo' is not registered",
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("tool 'echo' is not registered"),
    );
  });

  it('should throw when the same tool name is registered twice', () => {
    service.registerTool(buildEchoTool());

    expect(() => service.registerTool(buildEchoTool())).toThrow(ToolAlreadyRegisteredException);
  });

  it('should refuse a registered tool that is not on the current step allowlist', async () => {
    service.registerTool(buildEchoTool());
    const step: ToolExecutionStep = { stepId: 'step-2', allowedTools: ['some-other-tool'] };

    const result = await service.execute({ step, toolName: 'echo', rawArgs: { message: 'hi' } });

    expect(result).toEqual({
      kind: 'refused',
      reason: 'tool-not-allowed-for-step',
      detail: "tool 'echo' is not on the allowlist for step 'step-2'",
    });
  });

  it('should refuse when the authz hook denies the call, using its own reason', async () => {
    service.registerTool(buildEchoTool());
    mockAuthzHook.authorize.mockReturnValue({ allowed: false, reason: 'caller lacks role X' });

    const result = await service.execute({
      step: STEP,
      toolName: 'echo',
      rawArgs: { message: 'hi' },
    });

    expect(result).toEqual({
      kind: 'refused',
      reason: 'authz-denied',
      detail: 'caller lacks role X',
    });
  });

  it('should fall back to a generic reason when the authz hook denies without one', async () => {
    service.registerTool(buildEchoTool());
    mockAuthzHook.authorize.mockReturnValue({ allowed: false });

    const result = await service.execute({
      step: STEP,
      toolName: 'echo',
      rawArgs: { message: 'hi' },
    });

    expect(result).toEqual({
      kind: 'refused',
      reason: 'authz-denied',
      detail: "authorization denied for tool 'echo'",
    });
  });

  it('should refuse, not throw, when the authz hook itself throws', async () => {
    service.registerTool(buildEchoTool());
    mockAuthzHook.authorize.mockImplementation(() => {
      throw new Error('policy store unreachable');
    });

    const result = await service.execute({
      step: STEP,
      toolName: 'echo',
      rawArgs: { message: 'hi' },
    });

    expect(result).toEqual({
      kind: 'refused',
      reason: 'authz-hook-error',
      detail: "authorization check for 'echo' threw: policy store unreachable",
    });
  });

  it('should refuse when the authz hook throws a non-Error value', async () => {
    service.registerTool(buildEchoTool());
    mockAuthzHook.authorize.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately exercising the non-Error branch of the catch handler
      throw 'not an Error instance';
    });

    const result = await service.execute({
      step: STEP,
      toolName: 'echo',
      rawArgs: { message: 'hi' },
    });

    expect(result).toEqual({
      kind: 'refused',
      reason: 'authz-hook-error',
      detail: "authorization check for 'echo' threw: not an Error instance",
    });
  });

  it('should refuse arguments carrying a key the schema does not name, rather than stripping it', async () => {
    service.registerTool(buildEchoTool());

    const result = await service.execute({
      step: STEP,
      toolName: 'echo',
      rawArgs: { message: 'hi', extra: 'should not be silently dropped' },
    });

    expect(result.kind).toBe('refused');
    expect(result).toMatchObject({ kind: 'refused', reason: 'invalid-arguments' });
  });

  it('should refuse arguments of the wrong type', async () => {
    service.registerTool(buildEchoTool());

    const result = await service.execute({
      step: STEP,
      toolName: 'echo',
      rawArgs: { message: 42 },
    });

    expect(result).toMatchObject({ kind: 'refused', reason: 'invalid-arguments' });
  });

  it('should refuse a key the schema does not name inside a nested object, rather than stripping it', async () => {
    const step: ToolExecutionStep = { stepId: 'step-1', allowedTools: ['locate'] };
    service.registerTool({
      name: 'locate',
      argsSchema: z.object({ target: z.object({ path: z.string().min(1) }) }),
      handler: jest.fn().mockResolvedValue('ok'),
    });

    // Plain top-level `.strict()` would silently strip `scope` here (verified against this repo's
    // zod@4.4.3) and let the call through with only `path` — the exact "convention the next tool
    // forgets" the recursive registration-time strict wrap exists to close.
    const result = await service.execute({
      step,
      toolName: 'locate',
      rawArgs: { target: { path: '/reports/q3', scope: 'all-tenants' } },
    });

    expect(result).toMatchObject({ kind: 'refused', reason: 'invalid-arguments' });
  });

  it('should execute a nested object whose keys are all named by the schema', async () => {
    const step: ToolExecutionStep = { stepId: 'step-1', allowedTools: ['locate'] };
    const handler = jest.fn().mockResolvedValue('ok');
    service.registerTool({
      name: 'locate',
      argsSchema: z.object({ target: z.object({ path: z.string().min(1) }) }),
      handler,
    });

    const result = await service.execute({
      step,
      toolName: 'locate',
      rawArgs: { target: { path: '/reports/q3' } },
    });

    expect(result).toEqual({ kind: 'executed', result: 'ok' });
    expect(handler).toHaveBeenCalledWith({ target: { path: '/reports/q3' } });
  });

  it('should recursively strict nested objects reachable through arrays, optional, and nullable wrappers', async () => {
    const step: ToolExecutionStep = { stepId: 'step-1', allowedTools: ['bulk-locate'] };
    const handler = jest.fn().mockResolvedValue('ok');
    service.registerTool({
      name: 'bulk-locate',
      argsSchema: z.object({
        targets: z.array(z.object({ path: z.string().min(1) })),
        filter: z.object({ owner: z.string().min(1) }).optional(),
        fallback: z.object({ path: z.string().min(1) }).nullable(),
      }),
      handler,
    });

    const arrayLeak = await service.execute({
      step,
      toolName: 'bulk-locate',
      rawArgs: { targets: [{ path: '/a', scope: 'all-tenants' }], fallback: null },
    });
    expect(arrayLeak).toMatchObject({ kind: 'refused', reason: 'invalid-arguments' });

    const optionalLeak = await service.execute({
      step,
      toolName: 'bulk-locate',
      rawArgs: {
        targets: [{ path: '/a' }],
        filter: { owner: 'alice', scope: 'all-tenants' },
        fallback: null,
      },
    });
    expect(optionalLeak).toMatchObject({ kind: 'refused', reason: 'invalid-arguments' });

    const nullableLeak = await service.execute({
      step,
      toolName: 'bulk-locate',
      rawArgs: {
        targets: [{ path: '/a' }],
        fallback: { path: '/b', scope: 'all-tenants' },
      },
    });
    expect(nullableLeak).toMatchObject({ kind: 'refused', reason: 'invalid-arguments' });

    const result = await service.execute({
      step,
      toolName: 'bulk-locate',
      rawArgs: { targets: [{ path: '/a' }], filter: { owner: 'alice' }, fallback: { path: '/b' } },
    });
    expect(result).toEqual({ kind: 'executed', result: 'ok' });
    expect(handler).toHaveBeenCalledWith({
      targets: [{ path: '/a' }],
      filter: { owner: 'alice' },
      fallback: { path: '/b' },
    });
  });

  it('should execute the handler with the parsed arguments once every gate passes', async () => {
    const handler = jest.fn().mockResolvedValue({ echoed: 'hi' });
    service.registerTool(buildEchoTool(handler));

    const result = await service.execute({
      step: STEP,
      toolName: 'echo',
      rawArgs: { message: 'hi' },
    });

    expect(result).toEqual({ kind: 'executed', result: { echoed: 'hi' } });
    expect(handler).toHaveBeenCalledWith({ message: 'hi' });
    // `.mock.calls` rather than `toHaveBeenCalledWith(mockAuthzHook.authorize, ...)` — passing the
    // interface-typed method itself to `expect()` trips `@typescript-eslint/unbound-method`.
    expect(mockAuthzHook.authorize.mock.calls).toEqual([[{ step: STEP, toolName: 'echo' }]]);
  });
});
