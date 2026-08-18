import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { TypedConfigService } from '../../../../src/config/environment/typed-config.service';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { EvidenceRetrievalService } from '../../../../src/features/evidence/qa/evidence-retrieval.service';
import type { HybridRetrievalHitMetadata } from '../../../../src/providers/retrieval/mongo-hybrid.store';
import { FakeRetrievalStore } from '../../../../src/providers/retrieval/fake-retrieval.store';
import type { RetrievalHit } from '../../../../src/providers/retrieval/retrieval-store.interface';
import { RETRIEVAL_STORE } from '../../../../src/providers/retrieval/retrieval-store.interface';
import { emptyRetrievalCounter } from '../../../../src/providers/telemetry/domain-metrics';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';
import { getMockTypedConfig } from '../../../utils/get-mock-typed-config';

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

  const buildService = async (
    retrievalOverrides: Partial<ReturnType<typeof getMockTypedConfig>['retrieval']> = {},
  ): Promise<EvidenceRetrievalService> => {
    const config = getMockTypedConfig({
      retrieval: { fusion: 'server', limit: 12, ...retrievalOverrides },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvidenceRetrievalService,
        { provide: RETRIEVAL_STORE, useValue: fakeRetrievalStore },
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: TypedConfigService, useValue: config },
        { provide: AppLogger, useValue: getMockLogger() },
      ],
    }).compile();

    return module.get<EvidenceRetrievalService>(EvidenceRetrievalService);
  };

  beforeEach(async () => {
    fakeRetrievalStore = new FakeRetrievalStore();
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

  it("should pass config.retrieval.limit as the store query's limit", async () => {
    fakeRetrievalStore.setHits([]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'default' });

    expect(fakeRetrievalStore.queries[0].limit).toBe(12);
  });

  it('should drive the store query limit from config instead of a fixed value', async () => {
    service = await buildService({ limit: 5 });
    fakeRetrievalStore.setHits([]);

    await service.retrieve({ questionText: 'What is the cap rate?', tenantId: 'default' });

    expect(fakeRetrievalStore.queries[0].limit).toBe(5);
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
});
