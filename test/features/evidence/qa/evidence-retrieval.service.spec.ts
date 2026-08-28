import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { TypedConfigService } from '../../../../src/config/environment/typed-config.service';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { EvidenceRetrievalService } from '../../../../src/features/evidence/qa/evidence-retrieval.service';
import { RETRIEVAL_OVER_FETCH_MULTIPLIER } from '../../../../src/features/evidence/retrieval/retrieval.constant';
import type { HybridRetrievalHitMetadata } from '../../../../src/providers/retrieval/mongo-hybrid.store';
import { FakeRetrievalStore } from '../../../../src/providers/retrieval/fake-retrieval.store';
import type { RetrievalHit } from '../../../../src/providers/retrieval/retrieval-store.interface';
import { RETRIEVAL_STORE } from '../../../../src/providers/retrieval/retrieval-store.interface';
import { emptyRetrievalCounter } from '../../../../src/providers/telemetry/domain-metrics';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import type { MockLogger } from '../../../utils/get-mock-logger';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';
import { getMockTypedConfig } from '../../../utils/get-mock-typed-config';

// Mirrors mongo-hybrid.store.ts's fused-score formula (`sum(weight * (1 / (RRF_K + rank)))`,
// weight 1 per pipeline, RRF_K=60) so fixtures below exercise the score floor at the scale the
// real store can actually produce, rather than an arbitrary 0-1 domain it never reaches.
const RRF_K = 60;
const rrfScore = (rank: number, pipelines = 1): number => pipelines * (1 / (RRF_K + rank));

function buildHit(overrides: Partial<HybridRetrievalHitMetadata> = {}): RetrievalHit {
  return {
    id: 'chunk-1',
    score: 1,
    metadata: {
      text: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
      locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
      documentId: new Types.ObjectId().toString(),
      documentVersionId: new Types.ObjectId().toString(),
      tenantId: 'default',
      scoreBreakdown: [],
      ...overrides,
    },
  };
}

describe('EvidenceRetrievalService', () => {
  let service: EvidenceRetrievalService;
  let fakeRetrievalStore: FakeRetrievalStore;
  let mockLogger: MockLogger;
  const mockDocumentVersionModel = getMockModel();

  const buildService = async (
    retrievalOverrides: Partial<ReturnType<typeof getMockTypedConfig>['retrieval']> = {},
  ): Promise<EvidenceRetrievalService> => {
    const config = getMockTypedConfig({
      retrieval: { fusion: 'server', limit: 12, scoreFloor: 0, ...retrievalOverrides },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvidenceRetrievalService,
        { provide: RETRIEVAL_STORE, useValue: fakeRetrievalStore },
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: TypedConfigService, useValue: config },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    return module.get<EvidenceRetrievalService>(EvidenceRetrievalService);
  };

  beforeEach(async () => {
    fakeRetrievalStore = new FakeRetrievalStore();
    mockLogger = getMockLogger();
    service = await buildService();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should return an empty array without querying document versions when the store returns no hits', async () => {
    const emptyRetrievalSpy = jest.spyOn(emptyRetrievalCounter, 'add');
    fakeRetrievalStore.setHits([]);

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(result).toEqual([]);
    expect(mockDocumentVersionModel.find).not.toHaveBeenCalled();
    // Genuine zero-retrieval (the store returned nothing at all) must not be reported as the
    // score floor rejecting hits — that warning is reserved for the case where hits existed and
    // the floor dropped every one of them.
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(emptyRetrievalSpy).toHaveBeenCalledWith(1);
  });

  it('should not increment the empty-retrieval counter when the store returns hits', async () => {
    const emptyRetrievalSpy = jest.spyOn(emptyRetrievalCounter, 'add');
    const versionId = new Types.ObjectId();
    fakeRetrievalStore.setHits([buildHit({ documentVersionId: versionId.toString() })]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, sha256: 'a'.repeat(64) },
    ]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'default' });

    expect(emptyRetrievalSpy).not.toHaveBeenCalled();
  });

  it('should pass the tenantId through the retrieval filter', async () => {
    fakeRetrievalStore.setHits([]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'acme' });

    expect(fakeRetrievalStore.queries[0].filter).toEqual({ tenantId: 'acme' });
  });

  it("should over-fetch config.retrieval.limit by RETRIEVAL_OVER_FETCH_MULTIPLIER for the store query's limit", async () => {
    fakeRetrievalStore.setHits([]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'default' });

    expect(fakeRetrievalStore.queries[0].limit).toBe(12 * RETRIEVAL_OVER_FETCH_MULTIPLIER);
  });

  it('should drive the store query limit from config instead of a fixed value', async () => {
    service = await buildService({ limit: 5 });
    fakeRetrievalStore.setHits([]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'default' });

    expect(fakeRetrievalStore.queries[0].limit).toBe(5 * RETRIEVAL_OVER_FETCH_MULTIPLIER);
  });

  it("should join a retrieval hit back to its document version's sha256", async () => {
    const versionId = new Types.ObjectId();
    const hit = buildHit({ documentVersionId: versionId.toString() });
    fakeRetrievalStore.setHits([hit]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, sha256: 'a'.repeat(64) },
    ]);

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(result).toEqual([
      {
        chunkId: hit.id,
        docVersionId: versionId.toString(),
        sha256: 'a'.repeat(64),
        text: hit.metadata.text,
        locator: hit.metadata.locator,
      },
    ]);
    expect(mockDocumentVersionModel.find).toHaveBeenCalledWith({
      _id: { $in: [versionId] },
      tenantId: 'default',
    });
  });

  it('should scope the document version lookup to an explicit tenant, distinct from another tenant', async () => {
    const versionId = new Types.ObjectId();
    fakeRetrievalStore.setHits([buildHit({ documentVersionId: versionId.toString() })]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, sha256: 'a'.repeat(64) },
    ]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'acme' });

    expect(mockDocumentVersionModel.find).toHaveBeenCalledWith({
      _id: { $in: [versionId] },
      tenantId: 'acme',
    });
  });

  it('should throw InternalServerErrorException when a hit references a document version that no longer exists', async () => {
    fakeRetrievalStore.setHits([buildHit()]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([]);

    await expect(
      service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'default' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it("should exclude a withdrawn version's chunk from the retrieval results", async () => {
    const liveVersionId = new Types.ObjectId();
    const withdrawnVersionId = new Types.ObjectId();
    const liveHit = buildHit({ documentVersionId: liveVersionId.toString() });
    const withdrawnHit = buildHit({ documentVersionId: withdrawnVersionId.toString() });
    fakeRetrievalStore.setHits([liveHit, withdrawnHit]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: liveVersionId, sha256: 'a'.repeat(64) },
      { _id: withdrawnVersionId, sha256: 'b'.repeat(64), withdrawnAt: new Date() },
    ]);

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(result).toEqual([
      {
        chunkId: liveHit.id,
        docVersionId: liveVersionId.toString(),
        sha256: 'a'.repeat(64),
        text: liveHit.metadata.text,
        locator: liveHit.metadata.locator,
      },
    ]);
  });

  it('should still return config.retrieval.limit results when enough live chunks remain after withdrawn ones are dropped', async () => {
    service = await buildService({ limit: 2 });
    const withdrawnVersionId = new Types.ObjectId();
    const liveVersionIds = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    fakeRetrievalStore.setHits([
      buildHit({ documentVersionId: withdrawnVersionId.toString() }),
      ...liveVersionIds.map((versionId) => buildHit({ documentVersionId: versionId.toString() })),
    ]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: withdrawnVersionId, sha256: 'a'.repeat(64), withdrawnAt: new Date() },
      ...liveVersionIds.map((versionId) => ({ _id: versionId, sha256: 'b'.repeat(64) })),
    ]);

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(fakeRetrievalStore.queries[0].limit).toBe(2 * RETRIEVAL_OVER_FETCH_MULTIPLIER);
    expect(result).toHaveLength(2);
  });

  it('should keep a hit whose score is barely above zero at the default score floor', async () => {
    const versionId = new Types.ObjectId();
    const hit = { ...buildHit({ documentVersionId: versionId.toString() }), score: 0.001 };
    fakeRetrievalStore.setHits([hit]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, sha256: 'a'.repeat(64) },
    ]);

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(result).toHaveLength(1);
  });

  it('should drop hits below the configured score floor without dropping hits at or above it', async () => {
    const floor = rrfScore(1); // single-pipeline rank-1 contribution: 1 / (60 + 1)
    service = await buildService({ scoreFloor: floor });
    const belowVersionId = new Types.ObjectId();
    const atFloorVersionId = new Types.ObjectId();
    const aboveVersionId = new Types.ObjectId();
    fakeRetrievalStore.setHits([
      // Single-pipeline rank 2 scores below the rank-1 floor.
      { ...buildHit({ documentVersionId: belowVersionId.toString() }), score: rrfScore(2) },
      { ...buildHit({ documentVersionId: atFloorVersionId.toString() }), score: floor },
      // Both pipelines ranking the hit #1 is the highest score the store can ever produce.
      { ...buildHit({ documentVersionId: aboveVersionId.toString() }), score: rrfScore(1, 2) },
    ]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: atFloorVersionId, sha256: 'a'.repeat(64) },
      { _id: aboveVersionId, sha256: 'b'.repeat(64) },
    ]);

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(result.map((chunk) => chunk.docVersionId).sort()).toEqual(
      [atFloorVersionId.toString(), aboveVersionId.toString()].sort(),
    );
  });

  it('should abstain deterministically and report a distinct score-floor rejection, without querying document versions, when every hit is below the score floor', async () => {
    service = await buildService({ scoreFloor: rrfScore(1) });
    const emptyRetrievalSpy = jest.spyOn(emptyRetrievalCounter, 'add');
    fakeRetrievalStore.setHits([{ ...buildHit(), score: rrfScore(5) }]);

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(result).toEqual([]);
    expect(mockDocumentVersionModel.find).not.toHaveBeenCalled();
    expect(emptyRetrievalSpy).toHaveBeenCalledWith(1);
    // The store did return a hit — it just failed the floor. That must be distinguishable from
    // genuine zero-retrieval (see the earlier no-hits test), not folded into the same signal.
    // The warning carries the floor and the rejected count but never the raw question text —
    // `warn` reaches shipped log aggregation, unlike the `debug` line that logs the question.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Score floor ${rrfScore(1)} rejected all 1 hit(s)`),
    );
    expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('cap rate'));
  });

  it('should record an empty retrieval and return no results when every hit in the top-k is withdrawn', async () => {
    const emptyRetrievalSpy = jest.spyOn(emptyRetrievalCounter, 'add');
    const withdrawnVersionId = new Types.ObjectId();
    fakeRetrievalStore.setHits([buildHit({ documentVersionId: withdrawnVersionId.toString() })]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: withdrawnVersionId, sha256: 'a'.repeat(64), withdrawnAt: new Date() },
    ]);

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(result).toEqual([]);
    expect(emptyRetrievalSpy).toHaveBeenCalledWith(1);
  });
});
