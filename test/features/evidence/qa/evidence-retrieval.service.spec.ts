import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { EvidenceRetrievalService } from '../../../../src/features/evidence/qa/evidence-retrieval.service';
import type { HybridRetrievalHitMetadata } from '../../../../src/providers/retrieval/mongo-hybrid.store';
import { FakeRetrievalStore } from '../../../../src/providers/retrieval/fake-retrieval.store';
import type { RetrievalHit } from '../../../../src/providers/retrieval/retrieval-store.interface';
import { RETRIEVAL_STORE } from '../../../../src/providers/retrieval/retrieval-store.interface';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

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
  const mockDocumentVersionModel = getMockModel();

  beforeEach(async () => {
    fakeRetrievalStore = new FakeRetrievalStore();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvidenceRetrievalService,
        { provide: RETRIEVAL_STORE, useValue: fakeRetrievalStore },
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: AppLogger, useValue: getMockLogger() },
      ],
    }).compile();

    service = module.get<EvidenceRetrievalService>(EvidenceRetrievalService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should return an empty array without querying document versions when the store returns no hits', async () => {
    fakeRetrievalStore.setHits([]);

    const result = await service.retrieve({ questionText: 'What is the cap rate?' });

    expect(result).toEqual([]);
    expect(mockDocumentVersionModel.find).not.toHaveBeenCalled();
  });

  it('should default tenantId to the single-tenant default and pass it through the retrieval filter', async () => {
    fakeRetrievalStore.setHits([]);

    await service.retrieve({ questionText: 'What is the cap rate?' });

    expect(fakeRetrievalStore.queries[0].filter).toEqual({ tenantId: 'default' });
  });

  it('should pass an explicit tenantId through the retrieval filter instead of the default', async () => {
    fakeRetrievalStore.setHits([]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'acme' });

    expect(fakeRetrievalStore.queries[0].filter).toEqual({ tenantId: 'acme' });
  });

  it("should join a retrieval hit back to its document version's sha256", async () => {
    const versionId = new Types.ObjectId();
    const hit = buildHit({ documentVersionId: versionId.toString() });
    fakeRetrievalStore.setHits([hit]);
    mockDocumentVersionModel.find.mockResolvedValueOnce([
      { _id: versionId, sha256: 'a'.repeat(64) },
    ]);

    const result = await service.retrieve({ questionText: 'What is the cap rate?' });

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
      service.retrieve({ questionText: 'What is the cap rate?' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
