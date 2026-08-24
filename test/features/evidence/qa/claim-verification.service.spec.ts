import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { ClaimVerificationService } from '../../../../src/features/evidence/qa/claim-verification.service';
import type { ConflictedFactGroup } from '../../../../src/features/evidence/conflicts/conflicts.service';
import { ConflictsService } from '../../../../src/features/evidence/conflicts/conflicts.service';
import { FactsService } from '../../../../src/features/evidence/facts/facts.service';
import { EvidenceRetrievalService } from '../../../../src/features/evidence/qa/evidence-retrieval.service';
import type { RetrievedChunk } from '../../../../src/features/evidence/qa/types/retrieved-chunk.type';
import type { GroundingCellFact } from '../../../../src/features/evidence/qa/verify-claim';
import { MODEL_PROVIDER } from '../../../../src/providers/model/model-provider.interface';
import { FakeModelProvider } from '../../../../src/providers/model/fake-model.provider';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';

const PDF_LOCATOR: EvidenceLocator = { kind: 'pdf-page', extractorVersion: 'v1', page: 2 };
const SHA256_A = 'a'.repeat(64);

const CHUNK: RetrievedChunk = {
  chunkId: 'chunk-1',
  docVersionId: 'doc-v1',
  sha256: SHA256_A,
  text: 'Northgate Business Park traded in March 2025 at a cap rate of approximately 6.10%.',
  locator: PDF_LOCATOR,
};

const STATEMENT = 'Northgate Business Park traded at a cap rate of approximately 6.10%.';
const QUOTE = 'at a cap rate of approximately 6.10%';

interface Harness {
  readonly service: ClaimVerificationService;
  readonly modelProvider: FakeModelProvider;
  readonly evidenceRetrievalService: { retrieve: jest.Mock };
  readonly factsService: { findCellFacts: jest.Mock; findFactsForChunks: jest.Mock };
  readonly conflictsService: { findConflictedFactGroupsForChunks: jest.Mock };
}

async function buildHarness(): Promise<Harness> {
  const modelProvider = new FakeModelProvider();
  const evidenceRetrievalService = { retrieve: jest.fn().mockResolvedValue([CHUNK]) };
  const factsService = {
    findCellFacts: jest.fn().mockResolvedValue([]),
    findFactsForChunks: jest.fn().mockResolvedValue([]),
  };
  const conflictsService = {
    findConflictedFactGroupsForChunks: jest.fn().mockResolvedValue([]),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ClaimVerificationService,
      { provide: MODEL_PROVIDER, useValue: modelProvider },
      { provide: EvidenceRetrievalService, useValue: evidenceRetrievalService },
      { provide: FactsService, useValue: factsService },
      { provide: ConflictsService, useValue: conflictsService },
      { provide: AppLogger, useValue: getMockLogger() },
    ],
  }).compile();

  return {
    service: module.get(ClaimVerificationService),
    modelProvider,
    evidenceRetrievalService,
    factsService,
    conflictsService,
  };
}

describe('ClaimVerificationService', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should short-circuit to no_evidence_retrieved and never call the model or load facts/conflicts when nothing is retrieved', async () => {
    const harness = await buildHarness();
    harness.evidenceRetrievalService.retrieve.mockResolvedValueOnce([]);

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results).toEqual([{ claimIndex: 0, verdict: 'no_evidence_retrieved' }]);
    expect(harness.modelProvider.calls).toHaveLength(0);
    expect(harness.factsService.findCellFacts).not.toHaveBeenCalled();
    expect(harness.conflictsService.findConflictedFactGroupsForChunks).not.toHaveBeenCalled();
  });

  it('should return not_grounded with no reasonCode or citations when the model abstains', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueResult({ output: { supported: false } });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results).toEqual([{ claimIndex: 0, verdict: 'not_grounded' }]);
    expect(harness.modelProvider.calls).toHaveLength(1);
    expect(harness.modelProvider.calls[0].taskClass).toBe('claim_verification');
    expect(harness.modelProvider.calls[0].maxTokens).toBe(512);
    expect(harness.modelProvider.calls[0].maxCostUsd).toBe(0.25);
    expect(harness.modelProvider.calls[0].tenantId).toBe('tenant-1');
  });

  it('should return not_grounded with the failing check kind as reasonCode, and never surface the free-text drop reason, when a citation fails verification', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueResult({
      output: {
        supported: true,
        citations: [{ candidateIndex: 0, quote: 'a quote never present in the cited chunk' }],
      },
    });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results).toEqual([
      { claimIndex: 0, verdict: 'not_grounded', reasonCode: 'quote-not-found' },
    ]);
    expect(JSON.stringify(result)).not.toContain('does not appear in the cited chunk');
  });

  it('should return grounded with server-resolved citations for a surviving claim', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueResult({
      output: { supported: true, citations: [{ candidateIndex: 0, quote: QUOTE }] },
    });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results).toEqual([
      {
        claimIndex: 0,
        verdict: 'grounded',
        citations: [
          {
            chunkId: CHUNK.chunkId,
            docVersionId: CHUNK.docVersionId,
            sha256: CHUNK.sha256,
            locator: CHUNK.locator,
            quote: QUOTE,
          },
        ],
      },
    ]);
  });

  it('should return conflicting_evidence when a surviving claim touches a conflicted fact key', async () => {
    const harness = await buildHarness();
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const cellFacts: GroundingCellFact[] = [
      {
        chunkId: CHUNK.chunkId,
        factKey,
        value: { amount: 6.1, unit: 'percent' },
        locator: PDF_LOCATOR,
      },
    ];
    const conflictGroups: ConflictedFactGroup[] = [
      {
        conflictId: 'conflict-1',
        factKey,
        values: [
          { value: 6.1, unit: 'percent', sourceChunkId: CHUNK.chunkId },
          { value: 5.9, unit: 'percent', sourceChunkId: 'chunk-2' },
        ],
      },
    ];
    harness.factsService.findCellFacts.mockResolvedValueOnce(cellFacts);
    harness.conflictsService.findConflictedFactGroupsForChunks.mockResolvedValueOnce(
      conflictGroups,
    );
    harness.modelProvider.enqueueResult({
      output: { supported: true, citations: [{ candidateIndex: 0, quote: QUOTE }] },
    });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results[0].verdict).toBe('conflicting_evidence');
    expect(result.results[0].citations).toEqual([
      {
        chunkId: CHUNK.chunkId,
        docVersionId: CHUNK.docVersionId,
        sha256: CHUNK.sha256,
        locator: CHUNK.locator,
        quote: QUOTE,
      },
    ]);
  });

  it('should return conflicting_evidence for a claim resting on a conflicted fact extracted from prose, with no cell facts involved', async () => {
    const harness = await buildHarness();
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const conflictGroups: ConflictedFactGroup[] = [
      {
        conflictId: 'conflict-1',
        factKey,
        values: [
          { value: 6.1, unit: 'percent', sourceChunkId: CHUNK.chunkId },
          { value: 5.9, unit: 'percent', sourceChunkId: 'chunk-2' },
        ],
      },
    ];
    // No `findCellFacts` result: this fact only surfaces through `findFactsForChunks`, the
    // unfiltered lookup — proving the downgrade no longer depends on the fact being `xlsx-cell`.
    harness.factsService.findFactsForChunks.mockResolvedValueOnce([
      { chunkId: CHUNK.chunkId, factKey, value: { amount: 6.1, unit: 'percent' } },
    ]);
    harness.conflictsService.findConflictedFactGroupsForChunks.mockResolvedValueOnce(
      conflictGroups,
    );
    harness.modelProvider.enqueueResult({
      output: { supported: true, citations: [{ candidateIndex: 0, quote: QUOTE }] },
    });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results[0].verdict).toBe('conflicting_evidence');
    expect(harness.factsService.findFactsForChunks).toHaveBeenCalledWith(
      [CHUNK.chunkId],
      'tenant-1',
    );
  });

  it('should NOT downgrade to conflicting_evidence when the conflicted fact on a cited chunk names an entity the claim does not state', async () => {
    const harness = await buildHarness();
    const factKey = { entity: 'Southgate Plaza', metric: 'cap_rate', period: '2025-03' };
    const conflictGroups: ConflictedFactGroup[] = [
      {
        conflictId: 'conflict-1',
        factKey,
        values: [
          { value: 6.1, unit: 'percent', sourceChunkId: CHUNK.chunkId },
          { value: 5.9, unit: 'percent', sourceChunkId: 'chunk-2' },
        ],
      },
    ];
    // Same chunk, same value as the conflict — only the entity differs from what `STATEMENT` names,
    // so this must not attach.
    harness.factsService.findFactsForChunks.mockResolvedValueOnce([
      { chunkId: CHUNK.chunkId, factKey, value: { amount: 6.1, unit: 'percent' } },
    ]);
    harness.conflictsService.findConflictedFactGroupsForChunks.mockResolvedValueOnce(
      conflictGroups,
    );
    harness.modelProvider.enqueueResult({
      output: { supported: true, citations: [{ candidateIndex: 0, quote: QUOTE }] },
    });

    const result = await harness.service.verifyClaims({
      claims: [STATEMENT],
      tenantId: 'tenant-1',
    });

    expect(result.results[0].verdict).toBe('grounded');
  });

  it('should throw when the model cites a candidateIndex outside the offered candidates', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueResult({
      output: { supported: true, citations: [{ candidateIndex: 3, quote: QUOTE }] },
    });

    await expect(
      harness.service.verifyClaims({ claims: [STATEMENT], tenantId: 'tenant-1' }),
    ).rejects.toThrow(/candidate index 3/);
  });

  it('should propagate a model provider failure rather than emitting a verdict', async () => {
    const harness = await buildHarness();
    harness.modelProvider.enqueueError(new Error('spend refused'));

    await expect(
      harness.service.verifyClaims({ claims: [STATEMENT], tenantId: 'tenant-1' }),
    ).rejects.toThrow('spend refused');
  });
});
