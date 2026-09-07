import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { ContradictionCheckService } from '../../../../src/features/evidence/qa/contradiction-check.service';
import { contradictionCheckContractSchema } from '../../../../src/features/evidence/qa/contracts/contradiction-check.contract';
import type { RetrievedChunk } from '../../../../src/features/evidence/qa/types/retrieved-chunk.type';
import { MODEL_PROVIDER } from '../../../../src/providers/model/model-provider.interface';
import { FakeModelProvider } from '../../../../src/providers/model/fake-model.provider';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';

const PDF_LOCATOR: EvidenceLocator = { kind: 'pdf-page', extractorVersion: 'v1', page: 2 };

const CHUNK: RetrievedChunk = {
  chunkId: 'chunk-1',
  docVersionId: 'doc-v1',
  sha256: 'a'.repeat(64),
  text: 'Northgate Business Park traded in June 2025 at a cap rate of 5.10%.',
  locator: PDF_LOCATOR,
};

const ATOM = 'Northgate Business Park traded at a cap rate of 6.10%.';

interface Harness {
  readonly service: ContradictionCheckService;
  readonly modelProvider: FakeModelProvider;
}

async function buildHarness(): Promise<Harness> {
  const modelProvider = new FakeModelProvider();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ContradictionCheckService,
      { provide: MODEL_PROVIDER, useValue: modelProvider },
      { provide: AppLogger, useValue: getMockLogger() },
    ],
  }).compile();

  return { service: module.get(ContradictionCheckService), modelProvider };
}

describe('ContradictionCheckService', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should return checked with contradicted: true and the computed usage, folding cache tokens into promptTokens', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueResult({
      output: { contradicted: true },
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 5,
        cacheReadInputTokens: 3,
      },
      costUsd: 0.01,
    });

    const result = await harness.service.check({
      atom: ATOM,
      evidence: [CHUNK],
      tenantId: 'tenant-1',
    });

    expect(result).toEqual({
      kind: 'checked',
      contradicted: true,
      usage: { promptTokens: 108, completionTokens: 20, costUsd: 0.01 },
    });
  });

  it('should return checked with contradicted: false', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueResult({ output: { contradicted: false } });

    const result = await harness.service.check({
      atom: ATOM,
      evidence: [CHUNK],
      tenantId: 'tenant-1',
    });

    expect(result).toEqual({
      kind: 'checked',
      contradicted: false,
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
    });
  });

  it('should assert the model request fields', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueResult({ output: { contradicted: false } });

    await harness.service.check({ atom: ATOM, evidence: [CHUNK], tenantId: 'tenant-9' });

    expect(harness.modelProvider.calls).toHaveLength(1);
    const request = harness.modelProvider.calls[0];
    expect(request.taskClass).toBe('claim_verification');
    expect(request.maxTokens).toBe(512);
    expect(request.maxCostUsd).toBe(0.05);
    expect(request.tenantId).toBe('tenant-9');
    expect(request.outputSchema).toBe(contradictionCheckContractSchema);
  });

  it('should return unavailable and never throw when the provider rejects with an Error', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueError(new Error('spend refused'));

    const result = await harness.service.check({
      atom: ATOM,
      evidence: [CHUNK],
      tenantId: 'tenant-1',
    });

    expect(result).toEqual({ kind: 'unavailable', reason: 'spend refused' });
  });

  // `FakeModelProvider.enqueueError` only ever throws a real `Error` (its own `generate` checks
  // `instanceof Error` before throwing), so the ternary's non-Error branch needs a provider double
  // that rejects with a plain value — same convention `sources.service.spec.ts` and
  // `documents.service.spec.ts` use for this exact branch elsewhere in the codebase.
  it('should return unavailable and never throw when the provider rejects with a non-Error value', async () => {
    const modelProvider = {
      info: { provider: 'fake', model: 'fake-model' },
      generate: jest.fn().mockRejectedValueOnce('a plain string rejection'),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContradictionCheckService,
        { provide: MODEL_PROVIDER, useValue: modelProvider },
        { provide: AppLogger, useValue: getMockLogger() },
      ],
    }).compile();
    const service = module.get(ContradictionCheckService);

    const result = await service.check({ atom: ATOM, evidence: [CHUNK], tenantId: 'tenant-1' });

    expect(result).toEqual({ kind: 'unavailable', reason: 'a plain string rejection' });
  });
});
