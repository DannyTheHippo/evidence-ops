import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { SEARCH_EVIDENCE_TOOL_NAME } from '../../../../src/features/evidence/retrieval/evidence-tools';
import { TOOL_AUTHZ_HOOK } from '../../../../src/features/platform/authz/authz-hook.interface';
import { MCP_MUTATE_STEP, MCP_READ_STEP } from '../../../../src/mcp/mcp-tools';
import { StepPolicyAuthzHook } from '../../../../src/features/platform/authz/step-policy.authz-hook';
import { ToolExecutorService } from '../../../../src/features/platform/authz/tool-executor.service';
import type {
  ToolExecutionContext,
  ToolExecutionStep,
} from '../../../../src/features/platform/authz/types/tool-definition.type';
import { UserRole } from '../../../../src/shared/enums/user-role.enum';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';

function buildContext(role: UserRole): ToolExecutionContext {
  return { tenantId: 'tenant-1', actorId: 'actor-1', role };
}

describe('StepPolicyAuthzHook', () => {
  describe('authorize', () => {
    const hook = new StepPolicyAuthzHook();

    it('should allow a known step when the caller role meets the minimum', () => {
      const step: ToolExecutionStep = { stepId: 'qa-answer', allowedTools: ['echo'] };

      const decision = hook.authorize({
        step,
        toolName: 'echo',
        context: buildContext(UserRole.Member),
      });

      expect(decision).toEqual({ allowed: true });
    });

    it('should allow a known step when the caller role exceeds the minimum', () => {
      const step: ToolExecutionStep = { stepId: 'qa-answer', allowedTools: ['echo'] };

      const decision = hook.authorize({
        step,
        toolName: 'echo',
        context: buildContext(UserRole.Admin),
      });

      expect(decision).toEqual({ allowed: true });
    });

    it('should refuse a known step when the caller role is below the minimum', () => {
      const step: ToolExecutionStep = {
        stepId: 'data-room-export',
        allowedTools: ['export_data_room'],
      };

      const decision = hook.authorize({
        step,
        toolName: 'export_data_room',
        context: buildContext(UserRole.Member),
      });

      expect(decision).toEqual({
        allowed: false,
        reason:
          "role 'member' does not meet the minimum role 'admin' required for step 'data-room-export'",
      });
    });

    it('should refuse a step absent from the policy map', () => {
      const step: ToolExecutionStep = { stepId: 'unmapped-step', allowedTools: ['echo'] };

      const decision = hook.authorize({
        step,
        toolName: 'echo',
        context: buildContext(UserRole.Admin),
      });

      expect(decision).toEqual({
        allowed: false,
        reason: "no policy is configured for step 'unmapped-step'; refusing 'echo' by default",
      });
    });

    // `context.role` is typed `UserRole`, but nothing enforces that at the boundaries that
    // construct it (`src/worker/activities.ts` casts a plain-string workflow-history field with
    // `as UserRole`) — this proves the comparison refuses rather than treats an unranked role as
    // vacuously below every minimum.
    it('should refuse a known step when the caller role is not a recognized UserRole', () => {
      const step: ToolExecutionStep = { stepId: 'qa-answer', allowedTools: ['echo'] };

      const decision = hook.authorize({
        step,
        toolName: 'echo',
        context: { tenantId: 'tenant-1', actorId: 'actor-1', role: 'superadmin' as UserRole },
      });

      expect(decision).toEqual({
        allowed: false,
        reason: "role 'superadmin' is not a recognized role; refusing 'echo' by default",
      });
    });

    it('should allow the mcp-read step for a member — the same minimum qa-answer grants', () => {
      const decision = hook.authorize({
        step: MCP_READ_STEP,
        toolName: SEARCH_EVIDENCE_TOOL_NAME,
        context: buildContext(UserRole.Member),
      });

      expect(decision).toEqual({ allowed: true });
    });

    it('should refuse the mcp-mutate step for a member — floored at Admin, above mcp-read', () => {
      const decision = hook.authorize({
        step: MCP_MUTATE_STEP,
        toolName: 'request_resolution',
        context: buildContext(UserRole.Member),
      });

      expect(decision).toEqual({
        allowed: false,
        reason:
          "role 'member' does not meet the minimum role 'admin' required for step 'mcp-mutate'",
      });
    });

    it('should allow the mcp-mutate step for an admin', () => {
      const decision = hook.authorize({
        step: MCP_MUTATE_STEP,
        toolName: 'request_resolution',
        context: buildContext(UserRole.Admin),
      });

      expect(decision).toEqual({ allowed: true });
    });
  });

  // Mirrors `test/security/canary.spec.ts`'s real-`DenyAllAuthzHook` pattern: the real binding,
  // not a mock, so a refusal here proves the chokepoint's `refuse()` — and therefore its
  // `logger.warn` audit call — fires identically for this hook's denial as for `DenyAllAuthzHook`'s.
  describe('through ToolExecutorService, bound as the real TOOL_AUTHZ_HOOK', () => {
    let toolExecutor: ToolExecutorService;
    const mockLogger = getMockLogger();

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ToolExecutorService,
          { provide: TOOL_AUTHZ_HOOK, useClass: StepPolicyAuthzHook },
          { provide: AppLogger, useValue: mockLogger },
        ],
      }).compile();
      toolExecutor = module.get<ToolExecutorService>(ToolExecutorService);
      toolExecutor.registerTool({
        name: 'export_data_room',
        argsSchema: z.object({}),
        handler: jest.fn().mockResolvedValue('should never run'),
      });
    });

    afterEach(() => {
      jest.resetAllMocks();
    });

    it('should refuse and audit a step absent from the policy map', async () => {
      const step: ToolExecutionStep = {
        stepId: 'unmapped-step',
        allowedTools: ['export_data_room'],
      };

      const result = await toolExecutor.execute({
        step,
        toolName: 'export_data_room',
        rawArgs: {},
        context: buildContext(UserRole.Admin),
      });

      expect(result).toEqual({
        kind: 'refused',
        reason: 'authz-denied',
        detail:
          "no policy is configured for step 'unmapped-step'; refusing 'export_data_room' by default",
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("no policy is configured for step 'unmapped-step'"),
      );
    });

    it('should refuse and audit a known step when the caller role is insufficient', async () => {
      const step: ToolExecutionStep = {
        stepId: 'data-room-export',
        allowedTools: ['export_data_room'],
      };

      const result = await toolExecutor.execute({
        step,
        toolName: 'export_data_room',
        rawArgs: {},
        context: buildContext(UserRole.Member),
      });

      expect(result).toEqual({
        kind: 'refused',
        reason: 'authz-denied',
        detail:
          "role 'member' does not meet the minimum role 'admin' required for step 'data-room-export'",
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("does not meet the minimum role 'admin'"),
      );
    });

    it('should execute a known step when the caller role meets the minimum', async () => {
      const step: ToolExecutionStep = {
        stepId: 'data-room-export',
        allowedTools: ['export_data_room'],
      };

      const result = await toolExecutor.execute({
        step,
        toolName: 'export_data_room',
        rawArgs: {},
        context: buildContext(UserRole.Admin),
      });

      expect(result).toEqual({ kind: 'executed', result: 'should never run' });
    });

    it('should execute search_evidence on the qa-answer step for a member — the minimum that step requires', async () => {
      const step: ToolExecutionStep = {
        stepId: 'qa-answer',
        allowedTools: [SEARCH_EVIDENCE_TOOL_NAME],
      };
      toolExecutor.registerTool({
        name: SEARCH_EVIDENCE_TOOL_NAME,
        argsSchema: z.object({ query: z.string().min(1) }),
        handler: jest.fn().mockResolvedValue([]),
      });

      const result = await toolExecutor.execute({
        step,
        toolName: SEARCH_EVIDENCE_TOOL_NAME,
        rawArgs: { query: 'cap rate' },
        context: buildContext(UserRole.Member),
      });

      expect(result).toEqual({ kind: 'executed', result: [] });
    });
  });
});
