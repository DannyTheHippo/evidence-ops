import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { TypedConfigService } from '../../../../src/config/environment/typed-config.service';
import { Document } from '../../../../src/database/schemas/evidence/document/document.schema';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import type { SearchEvidenceInput } from '../../../../src/features/evidence/qa/evidence-retrieval.service';
import { EvidenceRetrievalService } from '../../../../src/features/evidence/qa/evidence-retrieval.service';
import { QueryEmbeddingCacheService } from '../../../../src/features/evidence/qa/query-embedding-cache.service';
import {
  MAX_RETRIEVAL_STORE_LIMIT,
  RETRIEVAL_OVER_FETCH_MULTIPLIER,
} from '../../../../src/features/evidence/retrieval/retrieval.constant';
import { EMBEDDING_PROVIDER } from '../../../../src/providers/embedding/embedding-provider.interface';
import { FakeEmbeddingProvider } from '../../../../src/providers/embedding/fake-embedding.provider';
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

// `FakeRetrievalStore.setHits` fixes its hits to the interface's default `Record<string,
// unknown>` metadata, so `hit.metadata.documentId` reads back as `unknown` — this narrows it back
// to the concrete shape `buildHit` actually constructs.
const documentIdOf = (hit: RetrievalHit): Types.ObjectId =>
  new Types.ObjectId((hit.metadata as unknown as HybridRetrievalHitMetadata).documentId);

function buildDocumentFixture(
  overrides: Partial<{
    _id: Types.ObjectId;
    title: string;
    sourceClass: string;
    createdAt: Date;
  }> = {},
): { _id: Types.ObjectId; title: string; sourceClass: string; createdAt: Date } {
  return {
    _id: new Types.ObjectId(),
    title: 'Q3 Rent Roll',
    sourceClass: 'unclassified',
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
    ...overrides,
  };
}

describe('EvidenceRetrievalService', () => {
  let service: EvidenceRetrievalService;
  let fakeRetrievalStore: FakeRetrievalStore;
  let fakeEmbeddingProvider: FakeEmbeddingProvider;
  let mockLogger: MockLogger;
  const mockDocumentVersionModel = getMockModel();
  const mockDocumentModel = getMockModel();

  const baseSearchInput = (overrides: Partial<SearchEvidenceInput> = {}): SearchEvidenceInput => ({
    questionText: 'What is the cap rate?',
    tenantId: 'default',
    skip: 0,
    limit: 20,
    sortDirection: 'desc',
    filter: {},
    ...overrides,
  });

  const buildService = async (
    retrievalOverrides: Partial<ReturnType<typeof getMockTypedConfig>['retrieval']> = {},
  ): Promise<EvidenceRetrievalService> => {
    const config = getMockTypedConfig({
      retrieval: { fusion: 'server', limit: 12, scoreFloor: 0, ...retrievalOverrides },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvidenceRetrievalService,
        QueryEmbeddingCacheService,
        { provide: RETRIEVAL_STORE, useValue: fakeRetrievalStore },
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: getModelToken(Document.name), useValue: mockDocumentModel },
        { provide: EMBEDDING_PROVIDER, useValue: fakeEmbeddingProvider },
        { provide: TypedConfigService, useValue: config },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    return module.get<EvidenceRetrievalService>(EvidenceRetrievalService);
  };

  beforeEach(async () => {
    fakeRetrievalStore = new FakeRetrievalStore();
    fakeEmbeddingProvider = new FakeEmbeddingProvider();
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
    expect(mockDocumentModel.find).not.toHaveBeenCalled();
    // Genuine zero-retrieval (the store returned nothing at all) must not be reported as the
    // score floor rejecting hits — that warning is reserved for the case where hits existed and
    // the floor dropped every one of them.
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(emptyRetrievalSpy).toHaveBeenCalledWith(1);
  });

  it('should not increment the empty-retrieval counter when the store returns hits', async () => {
    const emptyRetrievalSpy = jest.spyOn(emptyRetrievalCounter, 'add');
    const versionId = new Types.ObjectId();
    const hit = buildHit({ documentVersionId: versionId.toString() });
    const documentId = documentIdOf(hit);
    fakeRetrievalStore.setHits([hit]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, sha256: 'a'.repeat(64) },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([{ _id: documentId, title: 'Q3 Rent Roll' }]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'default' });

    expect(emptyRetrievalSpy).not.toHaveBeenCalled();
  });

  it('should pass the tenantId and the resolved query embedding through the retrieval query', async () => {
    fakeRetrievalStore.setHits([]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'acme' });

    expect(fakeRetrievalStore.queries[0].filter).toEqual({ tenantId: 'acme' });
    expect(fakeRetrievalStore.queries[0].vector).toEqual([0, 0, 0, 0]);
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

  it('should spend one live embedding for a repeated identical tenant and question', async () => {
    fakeRetrievalStore.setHits([]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'default' });
    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'default' });

    expect(fakeEmbeddingProvider.calls).toHaveLength(1);
  });

  it("should join a retrieval hit back to its document version's sha256, its document's title/sourceClass/createdAt, and carry the hit's score", async () => {
    const versionId = new Types.ObjectId();
    const hit = buildHit({ documentVersionId: versionId.toString(), text: 'excerpt' });
    const documentId = documentIdOf(hit);
    const document = buildDocumentFixture({
      _id: documentId,
      title: 'Northgate Business Park — Q3 Rent Roll',
      sourceClass: 'report',
      createdAt: new Date('2026-06-15T00:00:00.000Z'),
    });
    fakeRetrievalStore.setHits([hit]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, sha256: 'a'.repeat(64) },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([document]);

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
        score: hit.score,
        documentId: documentId.toString(),
        documentTitle: 'Northgate Business Park — Q3 Rent Roll',
        sourceClass: 'report',
        documentCreatedAt: document.createdAt,
      },
    ]);
    expect(mockDocumentVersionModel.find).toHaveBeenCalledWith({
      _id: { $in: [versionId] },
      tenantId: 'default',
    });
    expect(mockDocumentModel.find).toHaveBeenCalledWith({
      _id: { $in: [documentId] },
      tenantId: 'default',
    });
  });

  it('should scope the document version lookup to an explicit tenant, distinct from another tenant', async () => {
    const versionId = new Types.ObjectId();
    const hit = buildHit({ documentVersionId: versionId.toString() });
    const documentId = documentIdOf(hit);
    fakeRetrievalStore.setHits([hit]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, sha256: 'a'.repeat(64) },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([{ _id: documentId, title: 'Q3 Rent Roll' }]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'acme' });

    expect(mockDocumentVersionModel.find).toHaveBeenCalledWith({
      _id: { $in: [versionId] },
      tenantId: 'acme',
    });
    expect(mockDocumentModel.find).toHaveBeenCalledWith({
      _id: { $in: [documentId] },
      tenantId: 'acme',
    });
  });

  it('should throw InternalServerErrorException when a hit references a document version that no longer exists', async () => {
    fakeRetrievalStore.setHits([buildHit()]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([]);
    mockDocumentModel.find.mockResolvedValueOnce([]);

    await expect(
      service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'default' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('should throw InternalServerErrorException when a hit references a document that no longer exists', async () => {
    const versionId = new Types.ObjectId();
    fakeRetrievalStore.setHits([buildHit({ documentVersionId: versionId.toString() })]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, sha256: 'a'.repeat(64) },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([]);

    await expect(
      service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'default' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it("should exclude a withdrawn version's chunk from the retrieval results", async () => {
    const liveVersionId = new Types.ObjectId();
    const withdrawnVersionId = new Types.ObjectId();
    const liveHit = buildHit({ documentVersionId: liveVersionId.toString() });
    const withdrawnHit = buildHit({ documentVersionId: withdrawnVersionId.toString() });
    const liveDocumentId = documentIdOf(liveHit);
    fakeRetrievalStore.setHits([liveHit, withdrawnHit]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: liveVersionId, sha256: 'a'.repeat(64) },
      { _id: withdrawnVersionId, sha256: 'b'.repeat(64), withdrawnAt: new Date() },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([{ _id: liveDocumentId, title: 'Q3 Rent Roll' }]);

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
        score: liveHit.score,
        documentId: liveDocumentId.toString(),
        documentTitle: 'Q3 Rent Roll',
      },
    ]);
  });

  it('should still return config.retrieval.limit results when enough live chunks remain after withdrawn ones are dropped', async () => {
    service = await buildService({ limit: 2 });
    const withdrawnVersionId = new Types.ObjectId();
    const liveVersionIds = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    const withdrawnHit = buildHit({ documentVersionId: withdrawnVersionId.toString() });
    const liveHits = liveVersionIds.map((versionId) =>
      buildHit({ documentVersionId: versionId.toString() }),
    );
    fakeRetrievalStore.setHits([withdrawnHit, ...liveHits]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: withdrawnVersionId, sha256: 'a'.repeat(64), withdrawnAt: new Date() },
      ...liveVersionIds.map((versionId) => ({ _id: versionId, sha256: 'b'.repeat(64) })),
    ]);
    mockDocumentModel.find.mockResolvedValueOnce(
      liveHits.map((hit) => ({ _id: documentIdOf(hit), title: 'Q3 Rent Roll' })),
    );

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(fakeRetrievalStore.queries[0].limit).toBe(2 * RETRIEVAL_OVER_FETCH_MULTIPLIER);
    expect(result).toHaveLength(2);
  });

  it('should record an empty retrieval exactly once when every hit in the top-k is withdrawn', async () => {
    const emptyRetrievalSpy = jest.spyOn(emptyRetrievalCounter, 'add');
    const withdrawnVersionId = new Types.ObjectId();
    fakeRetrievalStore.setHits([buildHit({ documentVersionId: withdrawnVersionId.toString() })]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: withdrawnVersionId, sha256: 'a'.repeat(64), withdrawnAt: new Date() },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([]);

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(result).toEqual([]);
    expect(emptyRetrievalSpy).toHaveBeenCalledWith(1);
  });

  it('should keep a hit whose score is barely above zero at the default score floor', async () => {
    const versionId = new Types.ObjectId();
    const hit = { ...buildHit({ documentVersionId: versionId.toString() }), score: 0.001 };
    const documentId = documentIdOf(hit);
    fakeRetrievalStore.setHits([hit]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, sha256: 'a'.repeat(64) },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([{ _id: documentId, title: 'Q3 Rent Roll' }]);

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
    const atFloorHit = {
      ...buildHit({ documentVersionId: atFloorVersionId.toString() }),
      score: floor,
    };
    const aboveHit = {
      ...buildHit({ documentVersionId: aboveVersionId.toString() }),
      score: rrfScore(1, 2),
    };
    fakeRetrievalStore.setHits([
      // Single-pipeline rank 2 scores below the rank-1 floor.
      { ...buildHit({ documentVersionId: belowVersionId.toString() }), score: rrfScore(2) },
      atFloorHit,
      // Both pipelines ranking the hit #1 is the highest score the store can ever produce.
      aboveHit,
    ]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: atFloorVersionId, sha256: 'a'.repeat(64) },
      { _id: aboveVersionId, sha256: 'b'.repeat(64) },
    ]);
    mockDocumentModel.find.mockResolvedValueOnce([
      { _id: documentIdOf(atFloorHit), title: 'Q3 Rent Roll' },
      { _id: documentIdOf(aboveHit), title: 'Q3 Rent Roll' },
    ]);

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(result.map((chunk) => chunk.docVersionId).sort()).toEqual(
      [atFloorVersionId.toString(), aboveVersionId.toString()].sort(),
    );
  });

  it('should abstain deterministically and report a distinct score-floor rejection, exactly once, when every hit is below the score floor', async () => {
    service = await buildService({ scoreFloor: rrfScore(1) });
    const emptyRetrievalSpy = jest.spyOn(emptyRetrievalCounter, 'add');
    fakeRetrievalStore.setHits([{ ...buildHit(), score: rrfScore(5) }]);

    const result = await service.retrieve({
      questionText: 'What is the cap rate?',
      tenantId: 'default',
    });

    expect(result).toEqual([]);
    expect(mockDocumentVersionModel.find).not.toHaveBeenCalled();
    expect(mockDocumentModel.find).not.toHaveBeenCalled();
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

  describe('searchEvidence', () => {
    it('should page a filtered, sorted result and report hasMore', async () => {
      const versionIds = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
      const hits = [
        { ...buildHit({ documentVersionId: versionIds[0].toString() }), score: 0.3, id: 'c-low' },
        { ...buildHit({ documentVersionId: versionIds[1].toString() }), score: 0.9, id: 'c-high' },
        { ...buildHit({ documentVersionId: versionIds[2].toString() }), score: 0.6, id: 'c-mid' },
      ];
      fakeRetrievalStore.setHits(hits);
      mockDocumentVersionModel.find.mockResolvedValueOnce(
        versionIds.map((id) => ({ _id: id, sha256: 'a'.repeat(64) })),
      );
      mockDocumentModel.find.mockResolvedValueOnce(
        hits.map((hit) => buildDocumentFixture({ _id: documentIdOf(hit) })),
      );

      const result = await service.searchEvidence(baseSearchInput({ skip: 0, limit: 2 }));

      expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(['c-high', 'c-mid']);
      expect(result.hasMore).toBe(true);
    });

    it('should report hasMore false once the page reaches the end of the ranked set', async () => {
      const versionId = new Types.ObjectId();
      const hit = buildHit({ documentVersionId: versionId.toString() });
      fakeRetrievalStore.setHits([hit]);
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        { _id: versionId, sha256: 'a'.repeat(64) },
      ]);
      mockDocumentModel.find.mockResolvedValueOnce([
        buildDocumentFixture({ _id: documentIdOf(hit) }),
      ]);

      const result = await service.searchEvidence(baseSearchInput({ skip: 0, limit: 20 }));

      expect(result.chunks).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });

    it('should apply skip after the withdrawn-version drop, not before it', async () => {
      // Ranked by score descending: c-first (live), c-withdrawn (live but excluded from the
      // page), c-second and c-third (both live). If `skip` counted the withdrawn hit, `skip: 1`
      // would land on c-second here; applied after the drop, it must land past c-first in the
      // withdrawn-filtered set, i.e. still starting at c-second — proven by asserting c-third is
      // reached too, which only happens if the withdrawn hit never occupied a page slot.
      const liveVersionIds = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
      const withdrawnVersionId = new Types.ObjectId();
      const hits = [
        {
          ...buildHit({ documentVersionId: liveVersionIds[0].toString() }),
          score: 0.9,
          id: 'c-first',
        },
        {
          ...buildHit({ documentVersionId: withdrawnVersionId.toString() }),
          score: 0.8,
          id: 'c-withdrawn',
        },
        {
          ...buildHit({ documentVersionId: liveVersionIds[1].toString() }),
          score: 0.7,
          id: 'c-second',
        },
        {
          ...buildHit({ documentVersionId: liveVersionIds[2].toString() }),
          score: 0.6,
          id: 'c-third',
        },
      ];
      fakeRetrievalStore.setHits(hits);
      mockDocumentVersionModel.find.mockResolvedValueOnce([
        ...liveVersionIds.map((id) => ({ _id: id, sha256: 'a'.repeat(64) })),
        { _id: withdrawnVersionId, sha256: 'b'.repeat(64), withdrawnAt: new Date() },
      ]);
      mockDocumentModel.find.mockResolvedValueOnce(
        hits
          .filter((hit) => hit.id !== 'c-withdrawn')
          .map((hit) => buildDocumentFixture({ _id: documentIdOf(hit) })),
      );

      const result = await service.searchEvidence(baseSearchInput({ skip: 1, limit: 2 }));

      expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(['c-second', 'c-third']);
      expect(result.hasMore).toBe(false);
    });

    it('should sort ascending when sortDirection is asc', async () => {
      const versionIds = [new Types.ObjectId(), new Types.ObjectId()];
      const hits = [
        { ...buildHit({ documentVersionId: versionIds[0].toString() }), score: 0.9, id: 'c-high' },
        { ...buildHit({ documentVersionId: versionIds[1].toString() }), score: 0.3, id: 'c-low' },
      ];
      fakeRetrievalStore.setHits(hits);
      mockDocumentVersionModel.find.mockResolvedValueOnce(
        versionIds.map((id) => ({ _id: id, sha256: 'a'.repeat(64) })),
      );
      mockDocumentModel.find.mockResolvedValueOnce(
        hits.map((hit) => buildDocumentFixture({ _id: documentIdOf(hit) })),
      );

      const result = await service.searchEvidence(baseSearchInput({ sortDirection: 'asc' }));

      expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(['c-low', 'c-high']);
    });

    it('should filter to a single document by documentId, excluding chunks from other documents', async () => {
      const versionIds = [new Types.ObjectId(), new Types.ObjectId()];
      const hits = [
        { ...buildHit({ documentVersionId: versionIds[0].toString() }), id: 'c-keep' },
        { ...buildHit({ documentVersionId: versionIds[1].toString() }), id: 'c-drop' },
      ];
      const documents = hits.map((hit) => buildDocumentFixture({ _id: documentIdOf(hit) }));
      fakeRetrievalStore.setHits(hits);
      mockDocumentVersionModel.find.mockResolvedValueOnce(
        versionIds.map((id) => ({ _id: id, sha256: 'a'.repeat(64) })),
      );
      mockDocumentModel.find.mockResolvedValueOnce(documents);

      const result = await service.searchEvidence(
        baseSearchInput({ filter: { documentId: documents[0]._id.toString() } }),
      );

      expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(['c-keep']);
    });

    it('should filter by sourceClass, excluding a document of a different class', async () => {
      const versionIds = [new Types.ObjectId(), new Types.ObjectId()];
      const hits = [
        { ...buildHit({ documentVersionId: versionIds[0].toString() }), id: 'c-memo' },
        { ...buildHit({ documentVersionId: versionIds[1].toString() }), id: 'c-report' },
      ];
      fakeRetrievalStore.setHits(hits);
      mockDocumentVersionModel.find.mockResolvedValueOnce(
        versionIds.map((id) => ({ _id: id, sha256: 'a'.repeat(64) })),
      );
      mockDocumentModel.find.mockResolvedValueOnce([
        buildDocumentFixture({ _id: documentIdOf(hits[0]), sourceClass: 'memo' }),
        buildDocumentFixture({ _id: documentIdOf(hits[1]), sourceClass: 'report' }),
      ]);

      const result = await service.searchEvidence(
        baseSearchInput({ filter: { sourceClass: 'memo' } }),
      );

      expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(['c-memo']);
    });

    it('should filter out a document created before createdAfter', async () => {
      const versionIds = [new Types.ObjectId(), new Types.ObjectId()];
      const hits = [
        { ...buildHit({ documentVersionId: versionIds[0].toString() }), id: 'c-old' },
        { ...buildHit({ documentVersionId: versionIds[1].toString() }), id: 'c-new' },
      ];
      fakeRetrievalStore.setHits(hits);
      mockDocumentVersionModel.find.mockResolvedValueOnce(
        versionIds.map((id) => ({ _id: id, sha256: 'a'.repeat(64) })),
      );
      mockDocumentModel.find.mockResolvedValueOnce([
        buildDocumentFixture({
          _id: documentIdOf(hits[0]),
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
        }),
        buildDocumentFixture({
          _id: documentIdOf(hits[1]),
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      ]);

      const result = await service.searchEvidence(
        baseSearchInput({ filter: { createdAfter: new Date('2026-01-01T00:00:00.000Z') } }),
      );

      expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(['c-new']);
    });

    it('should filter out a document created after createdBefore', async () => {
      const versionIds = [new Types.ObjectId(), new Types.ObjectId()];
      const hits = [
        { ...buildHit({ documentVersionId: versionIds[0].toString() }), id: 'c-old' },
        { ...buildHit({ documentVersionId: versionIds[1].toString() }), id: 'c-new' },
      ];
      fakeRetrievalStore.setHits(hits);
      mockDocumentVersionModel.find.mockResolvedValueOnce(
        versionIds.map((id) => ({ _id: id, sha256: 'a'.repeat(64) })),
      );
      mockDocumentModel.find.mockResolvedValueOnce([
        buildDocumentFixture({
          _id: documentIdOf(hits[0]),
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
        }),
        buildDocumentFixture({
          _id: documentIdOf(hits[1]),
          createdAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      ]);

      const result = await service.searchEvidence(
        baseSearchInput({ filter: { createdBefore: new Date('2026-01-01T00:00:00.000Z') } }),
      );

      expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(['c-old']);
    });

    it('should size the store query from skip + limit rather than config.retrieval.limit', async () => {
      fakeRetrievalStore.setHits([]);

      await service.searchEvidence(baseSearchInput({ skip: 10, limit: 10 }));

      expect(fakeRetrievalStore.queries[0].limit).toBe((10 + 10) * RETRIEVAL_OVER_FETCH_MULTIPLIER);
    });

    it('should cap the store query limit at MAX_RETRIEVAL_STORE_LIMIT for a very deep page', async () => {
      fakeRetrievalStore.setHits([]);

      await service.searchEvidence(baseSearchInput({ skip: 100_000, limit: 100 }));

      expect(fakeRetrievalStore.queries[0].limit).toBe(MAX_RETRIEVAL_STORE_LIMIT);
    });

    it('should record an empty retrieval exactly once when the page comes back empty', async () => {
      const emptyRetrievalSpy = jest.spyOn(emptyRetrievalCounter, 'add');
      fakeRetrievalStore.setHits([]);

      const result = await service.searchEvidence(baseSearchInput());

      expect(result.chunks).toEqual([]);
      expect(emptyRetrievalSpy).toHaveBeenCalledWith(1);
    });
  });
});
