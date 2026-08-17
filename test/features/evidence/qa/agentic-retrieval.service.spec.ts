import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { TypedConfigService } from '../../../../src/config/environment/typed-config.service';
import {
  TOOL_AUTHZ_HOOK,
  type ToolAuthzHook,
} from '../../../../src/features/platform/authz/authz-hook.interface';
import { ToolExecutorService } from '../../../../src/features/platform/authz/tool-executor.service';
import type { ToolExecutionContext } from '../../../../src/features/platform/authz/types/tool-definition.type';
import { AGENTIC_RETRIEVAL_STEP } from '../../../../src/features/evidence/qa/agentic-retrieval-tools';
import { AgenticRetrievalService } from '../../../../src/features/evidence/qa/agentic-retrieval.service';
import { EvidenceRetrievalService } from '../../../../src/features/evidence/qa/evidence-retrieval.service';
import type { RetrievedChunk } from '../../../../src/features/evidence/qa/types/retrieved-chunk.type';
import { ModelBudgetExceededError } from '../../../../src/providers/model/errors/model-budget-exceeded.error';
import { FakeModelProvider } from '../../../../src/providers/model/fake-model.provider';
import { MODEL_PROVIDER } from '../../../../src/providers/model/model-provider.interface';
import { UserRole } from '../../../../src/shared/enums/user-role.enum';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger, type MockLogger } from '../../../utils/get-mock-logger';
import { getMockTypedConfig } from '../../../utils/get-mock-typed-config';

const CONTEXT: ToolExecutionContext = {
  tenantId: 'tenant-1',
  actorId: 'actor-1',
  role: UserRole.Member,
};

function buildChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: 'chunk-1',
    docVersionId: 'version-1',
    sha256: 'a'.repeat(64),
    text: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
    locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
    ...overrides,
  };
}

interface Harness {
  readonly service: AgenticRetrievalService;
  readonly modelProvider: FakeModelProvider;
  readonly evidenceRetrievalService: { retrieve: jest.Mock };
  readonly mockAuthzHook: jest.Mocked<ToolAuthzHook>;
  readonly mockLogger: MockLogger;
}

async function buildHarness(
  agenticRetrievalOverrides: { maxIterations?: number; maxCostUsd?: number } = {},
): Promise<Harness> {
  const modelProvider = new FakeModelProvider();
  const evidenceRetrievalService = { retrieve: jest.fn().mockResolvedValue([]) };
  const mockAuthzHook: jest.Mocked<ToolAuthzHook> = {
    authorize: jest.fn().mockReturnValue({ allowed: true }),
  };
  const config = getMockTypedConfig({
    agenticRetrieval: { maxIterations: 8, maxCostUsd: 1, ...agenticRetrievalOverrides },
  });
  const mockLogger = getMockLogger();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AgenticRetrievalService,
      ToolExecutorService,
      { provide: MODEL_PROVIDER, useValue: modelProvider },
      { provide: EvidenceRetrievalService, useValue: evidenceRetrievalService },
      { provide: TOOL_AUTHZ_HOOK, useValue: mockAuthzHook },
      { provide: TypedConfigService, useValue: config },
      { provide: AppLogger, useValue: mockLogger },
    ],
  }).compile();

  return {
    service: module.get(AgenticRetrievalService),
    modelProvider,
    evidenceRetrievalService,
    mockAuthzHook,
    mockLogger,
  };
}

describe('AgenticRetrievalService', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should terminate on no-tool-call when the model returns without requesting a tool', async () => {
    const { service, modelProvider } = await buildHarness();
    modelProvider.enqueueResult({ output: 'no search needed', stopReason: 'end_turn' });

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    expect(result).toEqual({
      chunks: [],
      iterations: 1,
      costUsd: 0,
      terminationReason: 'no-tool-call',
    });
    expect(modelProvider.calls).toHaveLength(1);
  });

  it('should terminate on no-tool-call when the model returns an empty toolCalls array', async () => {
    const { service, modelProvider } = await buildHarness();
    modelProvider.enqueueResult({ output: '', stopReason: 'tool_use', toolCalls: [] });

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    expect(result.terminationReason).toBe('no-tool-call');
    expect(result.chunks).toEqual([]);
  });

  it('should terminate on iteration-cap once the configured number of turns have run, even though the model keeps requesting tools', async () => {
    const { service, modelProvider } = await buildHarness({ maxIterations: 2, maxCostUsd: 10 });
    modelProvider.enqueueToolCall([
      { id: 'call_1', name: 'search_evidence', input: { query: 'a' } },
    ]);
    modelProvider.enqueueToolCall([
      { id: 'call_2', name: 'search_evidence', input: { query: 'b' } },
    ]);

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    expect(result.terminationReason).toBe('iteration-cap');
    expect(result.iterations).toBe(2);
    expect(modelProvider.calls).toHaveLength(2);
  });

  it('should terminate on iteration-cap immediately, calling the model zero times, when maxIterations is 0', async () => {
    const { service, modelProvider } = await buildHarness({ maxIterations: 0 });

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    expect(result).toEqual({
      chunks: [],
      iterations: 0,
      costUsd: 0,
      terminationReason: 'iteration-cap',
    });
    expect(modelProvider.calls).toHaveLength(0);
  });

  it('should terminate on cost-budget immediately, calling the model zero times, when maxCostUsd is 0', async () => {
    const { service, modelProvider } = await buildHarness({ maxCostUsd: 0 });

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    expect(result.terminationReason).toBe('cost-budget');
    expect(modelProvider.calls).toHaveLength(0);
  });

  it('should terminate on cost-budget once the running spend exhausts the configured budget, refusing a further turn before calling the model again', async () => {
    const { service, modelProvider } = await buildHarness({ maxIterations: 10, maxCostUsd: 0.05 });
    modelProvider.enqueueResult({
      output: '',
      stopReason: 'tool_use',
      toolCalls: [{ id: 'call_1', name: 'search_evidence', input: { query: 'a' } }],
      costUsd: 0.05,
    });

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    expect(result.terminationReason).toBe('cost-budget');
    expect(result.iterations).toBe(1);
    expect(result.costUsd).toBe(0.05);
    expect(modelProvider.calls).toHaveLength(1);
  });

  it("should terminate on cost-budget, not throw, when the provider's own assertBudget refuses a turn as ModelBudgetExceededError", async () => {
    const { service, modelProvider } = await buildHarness();
    modelProvider.enqueueError(new ModelBudgetExceededError(0.5, 0.25));

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    expect(result.terminationReason).toBe('cost-budget');
    expect(result.chunks).toEqual([]);
  });

  it('should propagate a non-budget error from the model provider rather than degrading', async () => {
    const { service, modelProvider } = await buildHarness();
    modelProvider.enqueueError(new Error('provider unreachable'));

    await expect(
      service.gatherEvidence({ questionText: 'What is the cap rate?', context: CONTEXT }),
    ).rejects.toThrow('provider unreachable');
  });

  it("should cap each turn's maxCostUsd at min(perTurnCap, remaining budget), shrinking as the loop spends", async () => {
    const { service, modelProvider, evidenceRetrievalService } = await buildHarness({
      maxIterations: 10,
      maxCostUsd: 0.3,
    });
    evidenceRetrievalService.retrieve.mockResolvedValueOnce([buildChunk()]);
    modelProvider.enqueueResult({
      output: '',
      stopReason: 'tool_use',
      toolCalls: [{ id: 'call_1', name: 'search_evidence', input: { query: 'cap rate' } }],
      costUsd: 0.2,
    });
    modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn', costUsd: 0.1 });

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    expect(modelProvider.calls[0].maxCostUsd).toBe(0.25);
    // Floating-point subtraction (0.3 - 0.2) — `toBeCloseTo` rather than `toBe`.
    expect(modelProvider.calls[1].maxCostUsd).toBeCloseTo(0.1, 10);
    expect(result.chunks).toEqual([buildChunk()]);
    expect(result.iterations).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.3, 10);
    expect(result.terminationReason).toBe('no-tool-call');
  });

  it('should run search_evidence through EvidenceRetrievalService using the server-derived context tenantId', async () => {
    const { service, modelProvider, evidenceRetrievalService } = await buildHarness();
    modelProvider.enqueueToolCall([
      { id: 'call_1', name: 'search_evidence', input: { query: 'cap rate' } },
    ]);
    modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

    await service.gatherEvidence({ questionText: 'What is the cap rate?', context: CONTEXT });

    expect(evidenceRetrievalService.retrieve).toHaveBeenCalledWith({
      questionText: 'cap rate',
      tenantId: 'tenant-1',
    });
  });

  it('should report "No matching evidence found." in the tool message when a search returns nothing', async () => {
    const { service, modelProvider } = await buildHarness();
    modelProvider.enqueueToolCall([
      { id: 'call_1', name: 'search_evidence', input: { query: 'x' } },
    ]);
    modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

    await service.gatherEvidence({ questionText: 'What is the cap rate?', context: CONTEXT });

    const toolMessage = modelProvider.calls[1].messages.find((m) => m.toolCallId === 'call_1');
    expect(toolMessage?.content).toBe('No matching evidence found.');
  });

  it('should accumulate only the real chunks EvidenceRetrievalService returned, deduplicated across overlapping searches', async () => {
    const { service, modelProvider, evidenceRetrievalService } = await buildHarness();
    const chunkA = buildChunk({ chunkId: 'chunk-a', text: 'first excerpt' });
    const chunkB = buildChunk({ chunkId: 'chunk-b', text: 'second excerpt' });
    evidenceRetrievalService.retrieve
      .mockResolvedValueOnce([chunkA])
      .mockResolvedValueOnce([chunkA, chunkB]);
    modelProvider.enqueueToolCall([
      { id: 'call_1', name: 'search_evidence', input: { query: 'a' } },
    ]);
    modelProvider.enqueueToolCall([
      { id: 'call_2', name: 'search_evidence', input: { query: 'b' } },
    ]);
    modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks).toEqual(expect.arrayContaining([chunkA, chunkB]));
  });

  it('should never fabricate a chunk from model text — a chunk-shaped string in the model output never reaches the gathered set', async () => {
    const { service, modelProvider } = await buildHarness();
    modelProvider.enqueueResult({
      output: JSON.stringify([buildChunk({ chunkId: 'fabricated', text: 'INJECTED_MARKER' })]),
      stopReason: 'end_turn',
    });

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    expect(result.chunks).toEqual([]);
  });

  it('should resolve fetch_chunks ids that were all previously seen via search_evidence', async () => {
    const { service, modelProvider, evidenceRetrievalService } = await buildHarness();
    const chunk = buildChunk({ chunkId: 'chunk-9' });
    evidenceRetrievalService.retrieve.mockResolvedValueOnce([chunk]);
    modelProvider.enqueueToolCall([
      { id: 'call_1', name: 'search_evidence', input: { query: 'a' } },
    ]);
    modelProvider.enqueueToolCall([
      { id: 'call_2', name: 'fetch_chunks', input: { ids: ['chunk-9'] } },
    ]);
    modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

    await service.gatherEvidence({ questionText: 'What is the cap rate?', context: CONTEXT });

    const fetchMessage = modelProvider.calls[2].messages.find((m) => m.toolCallId === 'call_2');
    expect(fetchMessage?.content).toContain('chunkId: chunk-9');
    expect(fetchMessage?.content).toContain(chunk.text);
    expect(fetchMessage?.content).not.toContain('Unknown chunkId');
  });

  it('should report every id as unknown when fetch_chunks is called with ids never returned by search_evidence', async () => {
    const { service, modelProvider } = await buildHarness();
    modelProvider.enqueueToolCall([
      { id: 'call_1', name: 'fetch_chunks', input: { ids: ['never-seen'] } },
    ]);
    modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

    await service.gatherEvidence({ questionText: 'What is the cap rate?', context: CONTEXT });

    const fetchMessage = modelProvider.calls[1].messages.find((m) => m.toolCallId === 'call_1');
    expect(fetchMessage?.content).toBe(
      'Unknown chunkId(s), not previously returned by search_evidence: never-seen',
    );
  });

  it('should mix found and unknown ids in one fetch_chunks response', async () => {
    const { service, modelProvider, evidenceRetrievalService } = await buildHarness();
    const chunk = buildChunk({ chunkId: 'chunk-9' });
    evidenceRetrievalService.retrieve.mockResolvedValueOnce([chunk]);
    modelProvider.enqueueToolCall([
      { id: 'call_1', name: 'search_evidence', input: { query: 'a' } },
    ]);
    modelProvider.enqueueToolCall([
      { id: 'call_2', name: 'fetch_chunks', input: { ids: ['chunk-9', 'never-seen'] } },
    ]);
    modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

    await service.gatherEvidence({ questionText: 'What is the cap rate?', context: CONTEXT });

    const fetchMessage = modelProvider.calls[2].messages.find((m) => m.toolCallId === 'call_2');
    expect(fetchMessage?.content).toContain('chunkId: chunk-9');
    expect(fetchMessage?.content).toContain(
      'Unknown chunkId(s), not previously returned by search_evidence: never-seen',
    );
  });

  it('should resolve every tool call in a multi-call turn, feeding each back with its own toolCallId', async () => {
    const { service, modelProvider, evidenceRetrievalService } = await buildHarness();
    const chunk = buildChunk({ chunkId: 'chunk-9' });
    evidenceRetrievalService.retrieve.mockResolvedValueOnce([chunk]);
    modelProvider.enqueueToolCall([
      { id: 'call_1', name: 'search_evidence', input: { query: 'a' } },
      { id: 'call_2', name: 'fetch_chunks', input: { ids: ['chunk-9'] } },
    ]);
    modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    const toolMessages = modelProvider.calls[1].messages.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(['call_1', 'call_2']);
    // `fetch_chunks` resolved `chunk-9` within the same turn `search_evidence` surfaced it.
    expect(toolMessages[1].content).toContain('chunkId: chunk-9');
    expect(result.chunks).toEqual([chunk]);
  });

  it('should truncate a long chunk to a snippet in the search_evidence result, without truncating it when fetched in full', async () => {
    const longText = 'x'.repeat(500);
    const { service, modelProvider, evidenceRetrievalService } = await buildHarness();
    evidenceRetrievalService.retrieve.mockResolvedValueOnce([
      buildChunk({ chunkId: 'chunk-long', text: longText }),
    ]);
    modelProvider.enqueueToolCall([
      { id: 'call_1', name: 'search_evidence', input: { query: 'a' } },
    ]);
    modelProvider.enqueueToolCall([
      { id: 'call_2', name: 'fetch_chunks', input: { ids: ['chunk-long'] } },
    ]);
    modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

    await service.gatherEvidence({ questionText: 'What is the cap rate?', context: CONTEXT });

    const searchMessage = modelProvider.calls[1].messages.find((m) => m.toolCallId === 'call_1');
    const fetchMessage = modelProvider.calls[2].messages.find((m) => m.toolCallId === 'call_2');
    expect(searchMessage?.content).not.toContain(longText);
    expect(searchMessage?.content).toContain('x'.repeat(320) + '…');
    expect(fetchMessage?.content).toContain(longText);
  });

  it('should feed a tool refusal back as a tool result and continue the loop rather than stopping', async () => {
    const { service, modelProvider, mockAuthzHook } = await buildHarness();
    mockAuthzHook.authorize.mockReturnValueOnce({ allowed: false, reason: 'caller lacks role X' });
    modelProvider.enqueueToolCall([
      { id: 'call_1', name: 'search_evidence', input: { query: 'a' } },
    ]);
    modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

    const result = await service.gatherEvidence({
      questionText: 'What is the cap rate?',
      context: CONTEXT,
    });

    expect(modelProvider.calls).toHaveLength(2);
    const refusalMessage = modelProvider.calls[1].messages.find((m) => m.toolCallId === 'call_1');
    expect(refusalMessage?.content).toBe('Refused: caller lacks role X');
    expect(result.chunks).toEqual([]);
  });

  it('should refuse arguments outside the strict schema instead of executing, and feed that refusal back too', async () => {
    const { service, modelProvider } = await buildHarness();
    modelProvider.enqueueToolCall([
      { id: 'call_1', name: 'search_evidence', input: { query: 'a', tenantId: 'attacker-tenant' } },
    ]);
    modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

    await service.gatherEvidence({ questionText: 'What is the cap rate?', context: CONTEXT });

    const refusalMessage = modelProvider.calls[1].messages.find((m) => m.toolCallId === 'call_1');
    expect(refusalMessage?.content).toContain('Refused:');
  });

  describe('all-tool-calls-refused', () => {
    it('should terminate on all-tool-calls-refused and warn once every attempted tool call in the run was refused', async () => {
      const { service, modelProvider, mockAuthzHook, mockLogger } = await buildHarness();
      mockAuthzHook.authorize.mockReturnValue({ allowed: false, reason: 'caller lacks role X' });
      modelProvider.enqueueToolCall([
        { id: 'call_1', name: 'search_evidence', input: { query: 'a' } },
      ]);
      modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

      const result = await service.gatherEvidence({
        questionText: 'What is the cap rate?',
        context: CONTEXT,
      });

      expect(result.terminationReason).toBe('all-tool-calls-refused');
      expect(result.chunks).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`for step '${AGENTIC_RETRIEVAL_STEP.stepId}'`),
      );
    });

    it('should terminate on all-tool-calls-refused when every call across a multi-call turn was refused', async () => {
      const { service, modelProvider, mockAuthzHook } = await buildHarness();
      mockAuthzHook.authorize.mockReturnValue({ allowed: false, reason: 'caller lacks role X' });
      modelProvider.enqueueToolCall([
        { id: 'call_1', name: 'search_evidence', input: { query: 'a' } },
        { id: 'call_2', name: 'fetch_chunks', input: { ids: ['chunk-1'] } },
      ]);
      modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

      const result = await service.gatherEvidence({
        questionText: 'What is the cap rate?',
        context: CONTEXT,
      });

      expect(result.terminationReason).toBe('all-tool-calls-refused');
    });

    it('should not report all-tool-calls-refused when at least one attempted call executed, even if another was refused', async () => {
      const { service, modelProvider, mockAuthzHook, evidenceRetrievalService, mockLogger } =
        await buildHarness();
      evidenceRetrievalService.retrieve.mockResolvedValueOnce([buildChunk()]);
      mockAuthzHook.authorize
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({ allowed: false, reason: 'caller lacks role X' });
      modelProvider.enqueueToolCall([
        { id: 'call_1', name: 'search_evidence', input: { query: 'a' } },
      ]);
      modelProvider.enqueueToolCall([
        { id: 'call_2', name: 'search_evidence', input: { query: 'b' } },
      ]);
      modelProvider.enqueueResult({ output: 'done', stopReason: 'end_turn' });

      const result = await service.gatherEvidence({
        questionText: 'What is the cap rate?',
        context: CONTEXT,
      });

      expect(result.terminationReason).toBe('no-tool-call');
      expect(result.chunks).toEqual([buildChunk()]);
      // `ToolExecutorService.refuse` still logs its own per-call warn for `call_2` — this asserts
      // only that the run-level "every tool call refused" summary was not raised on top of it.
      expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('every tool call'));
    });

    it('should not report all-tool-calls-refused when no tool call was ever attempted', async () => {
      const { service, modelProvider, mockLogger } = await buildHarness();
      modelProvider.enqueueResult({ output: 'no search needed', stopReason: 'end_turn' });

      const result = await service.gatherEvidence({
        questionText: 'What is the cap rate?',
        context: CONTEXT,
      });

      expect(result.terminationReason).toBe('no-tool-call');
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });
});
