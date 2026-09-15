import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

// Mocking the module root (not a prototype) is required the same way
// `anthropic-model.provider.spec.ts` does for `@anthropic-ai/sdk` — `TemporalWorkflowEngine`
// builds its own `Client`/`Connection` internally with no way to inject one. The mock functions
// are declared before `jest.mock` (names must start with `mock` — Jest's hoisting requires it)
// and referenced directly everywhere below, rather than re-extracted via `Connection.connect` /
// `Client` after import, which would trip `@typescript-eslint/unbound-method` against the real
// SDK's typed (non-`this: void`) method signatures.
const mockConnectionConnect = jest.fn();
const mockClient = jest.fn();
const mockClose = jest.fn();
const mockStart = jest.fn();
const mockGetHandle = jest.fn();
const mockSignal = jest.fn();

// `WorkflowNotFoundError`, `NamespaceNotFoundError` and `ServiceError` are re-exported from the
// real module (via `jest.requireActual`) rather than stubbed, so `instanceof WorkflowNotFoundError`
// inside `TemporalWorkflowEngine.status()` still matches an instance built from the same import
// below, and the negative cases below construct real Temporal error classes rather than lookalikes.
jest.mock('@temporalio/client', () => {
  const actual = jest.requireActual<typeof import('@temporalio/client')>('@temporalio/client');
  return {
    __esModule: true,
    Connection: { connect: mockConnectionConnect },
    Client: mockClient,
    WorkflowNotFoundError: actual.WorkflowNotFoundError,
    NamespaceNotFoundError: actual.NamespaceNotFoundError,
    ServiceError: actual.ServiceError,
  };
});

import { NamespaceNotFoundError, ServiceError, WorkflowNotFoundError } from '@temporalio/client';
import { WorkflowEngineNotFoundError } from '../../../src/providers/workflow-engine/errors/workflow-engine-not-found.error';
import { TemporalWorkflowEngine } from '../../../src/providers/workflow-engine/temporal-workflow.engine';

describe('TemporalWorkflowEngine', () => {
  const config = getMockTypedConfig();

  beforeEach(() => {
    mockConnectionConnect.mockResolvedValue({ close: mockClose });
    mockClient.mockImplementation(() => ({
      workflow: { start: mockStart, getHandle: mockGetHandle },
    }));
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should not connect to Temporal on construction', () => {
    new TemporalWorkflowEngine(config);

    expect(mockConnectionConnect).not.toHaveBeenCalled();
  });

  it('should start a workflow against the configured task queue and return a running handle', async () => {
    mockStart.mockResolvedValue({ workflowId: 'wf-1' });
    const engine = new TemporalWorkflowEngine(config);

    const handle = await engine.start('ingestDocumentVersion', { documentVersionId: 'doc-1' });

    expect(mockConnectionConnect).toHaveBeenCalledWith({ address: 'localhost:7233' });
    expect(mockClient).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'default' }));
    expect(mockStart).toHaveBeenCalledWith(
      'ingestDocumentVersion',
      expect.objectContaining({
        taskQueue: 'evidence-ops',
        args: [{ documentVersionId: 'doc-1' }],
      }),
    );
    expect(handle).toEqual({ id: 'wf-1', status: 'running' });
  });

  it('should reuse the same connection and client across multiple calls', async () => {
    mockStart.mockResolvedValue({ workflowId: 'wf-1' });
    const engine = new TemporalWorkflowEngine(config);

    await engine.start('a', {});
    await engine.start('b', {});

    expect(mockConnectionConnect).toHaveBeenCalledTimes(1);
    // Regression: a `Client` built fresh per call is never shut down.
    expect(mockClient).toHaveBeenCalledTimes(1);
  });

  it.each<[string, 'running' | 'completed' | 'failed']>([
    ['RUNNING', 'running'],
    ['CONTINUED_AS_NEW', 'running'],
    ['COMPLETED', 'completed'],
    ['FAILED', 'failed'],
    ['CANCELLED', 'failed'],
    ['TERMINATED', 'failed'],
    ['TIMED_OUT', 'failed'],
    ['UNSPECIFIED', 'failed'],
  ])('should map Temporal status %s to %s', async (temporalStatus, expected) => {
    mockGetHandle.mockReturnValue({
      describe: jest.fn().mockResolvedValue({ status: { name: temporalStatus } }),
    });
    const engine = new TemporalWorkflowEngine(config);

    const handle = await engine.status('wf-1');

    expect(mockGetHandle).toHaveBeenCalledWith('wf-1');
    expect(handle).toEqual({ id: 'wf-1', status: expected });
  });

  it('should reject with WorkflowEngineNotFoundError when Temporal reports the workflow unknown to it', async () => {
    const notFound = new WorkflowNotFoundError('workflow not found', 'wf-1', undefined);
    mockGetHandle.mockReturnValue({ describe: jest.fn().mockRejectedValue(notFound) });
    const engine = new TemporalWorkflowEngine(config);

    const rejection = engine.status('wf-1');

    await expect(rejection).rejects.toBeInstanceOf(WorkflowEngineNotFoundError);
    await expect(rejection).rejects.toMatchObject({ workflowId: 'wf-1', cause: notFound });
  });

  it.each<[string, Error]>([
    ['a plain Error', new Error('temporal unreachable')],
    ['NamespaceNotFoundError', new NamespaceNotFoundError('default')],
    ['ServiceError', new ServiceError('service unavailable')],
  ])(
    'should propagate %s from status() unchanged, not as WorkflowEngineNotFoundError',
    async (_name, error) => {
      mockGetHandle.mockReturnValue({ describe: jest.fn().mockRejectedValue(error) });
      const engine = new TemporalWorkflowEngine(config);

      const rejection = engine.status('wf-1');

      await expect(rejection).rejects.toBe(error);
      await expect(rejection).rejects.not.toBeInstanceOf(WorkflowEngineNotFoundError);
    },
  );

  it('should signal a running workflow by id, name, and payload', async () => {
    mockGetHandle.mockReturnValue({ signal: mockSignal });
    const engine = new TemporalWorkflowEngine(config);

    await engine.signal('wf-1', 'approvalDecision', { claimedDecision: 'approved' });

    expect(mockGetHandle).toHaveBeenCalledWith('wf-1');
    expect(mockSignal).toHaveBeenCalledWith('approvalDecision', { claimedDecision: 'approved' });
  });

  it('should close the connection on module destroy if one was opened', async () => {
    mockStart.mockResolvedValue({ workflowId: 'wf-1' });
    const engine = new TemporalWorkflowEngine(config);
    await engine.start('a', {});

    await engine.onModuleDestroy();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('should no-op on module destroy when no connection was ever opened', async () => {
    const engine = new TemporalWorkflowEngine(config);

    await engine.onModuleDestroy();

    expect(mockClose).not.toHaveBeenCalled();
  });

  it('should propagate a connection failure to the caller', async () => {
    mockConnectionConnect.mockReset().mockRejectedValue(new Error('connect refused'));
    const engine = new TemporalWorkflowEngine(config);

    await expect(engine.start('a', {})).rejects.toThrow('connect refused');
  });

  it('should retry the connection on the next call after a rejection rather than reusing it', async () => {
    mockConnectionConnect.mockReset().mockRejectedValueOnce(new Error('connect refused'));
    mockConnectionConnect.mockResolvedValueOnce({ close: mockClose });
    mockStart.mockResolvedValue({ workflowId: 'wf-1' });
    const engine = new TemporalWorkflowEngine(config);

    await expect(engine.start('a', {})).rejects.toThrow('connect refused');
    const handle = await engine.start('b', {});

    expect(mockConnectionConnect).toHaveBeenCalledTimes(2);
    expect(handle).toEqual({ id: 'wf-1', status: 'running' });
  });
});
