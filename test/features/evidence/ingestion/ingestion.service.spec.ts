import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { EvidenceChunk } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { DocumentVersionNotFoundException } from '../../../../src/features/evidence/ingestion/exceptions/ingestion.exception';
import { IngestionService } from '../../../../src/features/evidence/ingestion/ingestion.service';
import { ParserRegistry } from '../../../../src/features/evidence/ingestion/parser.registry';
import type {
  DocumentParser,
  ParsedDocument,
} from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import { EMBEDDING_PROVIDER } from '../../../../src/providers/embedding/embedding-provider.interface';
import { FakeEmbeddingProvider } from '../../../../src/providers/embedding/fake-embedding.provider';
import { DOCUMENT_STORE } from '../../../../src/providers/storage/document-store.interface';
import { FakeDocumentStore } from '../../../../src/providers/storage/fake-document.store';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('IngestionService', () => {
  let service: IngestionService;
  let fakeDocumentStore: FakeDocumentStore;
  let fakeEmbeddingProvider: FakeEmbeddingProvider;

  const mockDocumentVersionModel = getMockModel();
  const mockEvidenceChunkModel = getMockModel();
  const mockParserRegistry = { resolve: jest.fn() } satisfies Record<
    keyof Pick<ParserRegistry, 'resolve'>,
    jest.Mock
  >;

  const versionId = new Types.ObjectId();
  const documentId = new Types.ObjectId();
  const PDF_MIME = 'application/pdf';

  const buildVersion = (overrides: Record<string, unknown> = {}) => ({
    _id: versionId,
    documentId,
    storageKey: 'not-set',
    tenantId: 'default',
    ingestionStatus: 'pending',
    ...overrides,
  });

  const buildStubParser = (elements: ParsedDocument['elements']): DocumentParser => ({
    supports: [PDF_MIME],
    parse: jest.fn().mockResolvedValue({ elements, extractorVersion: 'pdf-pdfjs-1' }),
  });

  // `getMockModel`'s `findOneAndUpdate` is typed only on its return value, so `.mock.calls`
  // comes back untyped — recast the mock itself (mirroring `insertManyMock` below) rather than
  // reach for `expect.any(...)`, whose `any`-typed return trips `no-unsafe-assignment` wherever
  // it lands inside an object literal.
  const getFindOneAndUpdateCall = (
    nth: number,
  ): [filter: Record<string, unknown>, update: Record<string, unknown>] => {
    const mock = mockDocumentVersionModel.findOneAndUpdate as jest.Mock<
      Promise<unknown>,
      [Record<string, unknown>, Record<string, unknown>]
    >;
    return mock.mock.calls[nth - 1];
  };

  beforeEach(async () => {
    fakeDocumentStore = new FakeDocumentStore();
    fakeEmbeddingProvider = new FakeEmbeddingProvider();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionService,
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: getModelToken(EvidenceChunk.name), useValue: mockEvidenceChunkModel },
        { provide: DOCUMENT_STORE, useValue: fakeDocumentStore },
        { provide: EMBEDDING_PROVIDER, useValue: fakeEmbeddingProvider },
        { provide: ParserRegistry, useValue: mockParserRegistry },
        { provide: AppLogger, useValue: getMockLogger() },
      ],
    }).compile();

    service = module.get<IngestionService>(IngestionService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should throw DocumentVersionNotFoundException for a malformed id, without querying the model', async () => {
    await expect(service.ingestVersion('not-an-object-id')).rejects.toBeInstanceOf(
      DocumentVersionNotFoundException,
    );
    expect(mockDocumentVersionModel.findById).not.toHaveBeenCalled();
  });

  it('should throw DocumentVersionNotFoundException when the version does not exist', async () => {
    mockDocumentVersionModel.findById.mockResolvedValueOnce(null);

    await expect(service.ingestVersion(versionId.toString())).rejects.toBeInstanceOf(
      DocumentVersionNotFoundException,
    );
  });

  it('should skip re-ingestion and leave the store untouched when the version is already marked completed', async () => {
    mockDocumentVersionModel.findById.mockResolvedValueOnce(
      buildVersion({ ingestionStatus: 'completed' }),
    );
    const getSpy = jest.spyOn(fakeDocumentStore, 'get');

    const result = await service.ingestVersion(versionId.toString());

    expect(result).toEqual({ chunksCreated: 0, alreadyIngested: true });
    expect(getSpy).not.toHaveBeenCalled();
    expect(mockEvidenceChunkModel.deleteMany).not.toHaveBeenCalled();
    expect(mockEvidenceChunkModel.insertMany).not.toHaveBeenCalled();
  });

  it('should throw InternalServerErrorException when the store has no bytes for a recorded storageKey', async () => {
    mockDocumentVersionModel.findById.mockResolvedValueOnce(
      buildVersion({ storageKey: 'missing-key' }),
    );

    await expect(service.ingestVersion(versionId.toString())).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    // Recovery runs before the store read: a not-`completed` version is cleared of any
    // half-ingested chunks unconditionally, regardless of what fails afterward.
    expect(mockEvidenceChunkModel.deleteMany).toHaveBeenCalledWith({
      documentVersionId: versionId,
    });
  });

  it('should return a no-op result and mark the version completed when parsing yields no elements to chunk', async () => {
    const stored = await fakeDocumentStore.put({
      content: Buffer.from('%PDF-empty'),
      contentType: PDF_MIME,
      metadata: {},
    });
    const version = buildVersion({ storageKey: stored.id });
    mockDocumentVersionModel.findById.mockResolvedValueOnce(version);
    mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([]));

    const result = await service.ingestVersion(versionId.toString());

    expect(result).toEqual({ chunksCreated: 0, alreadyIngested: false });
    expect(fakeEmbeddingProvider.calls).toHaveLength(0);
    expect(mockEvidenceChunkModel.insertMany).not.toHaveBeenCalled();

    const [finalizeFilter, finalizeUpdate] = getFindOneAndUpdateCall(2);
    expect(finalizeFilter._id).toBe(versionId);
    expect(finalizeFilter.ingestionLeaseToken).toBeInstanceOf(Types.ObjectId);
    expect(finalizeUpdate).toEqual({
      $set: { ingestionStatus: 'completed' },
      $unset: { ingestionLeaseToken: '' },
    });
  });

  it('should parse, chunk, embed as document input, and persist chunks for a new version', async () => {
    const stored = await fakeDocumentStore.put({
      content: Buffer.from('%PDF-1.4 fixture bytes'),
      contentType: PDF_MIME,
      metadata: {},
    });
    const version = buildVersion({ storageKey: stored.id });
    mockDocumentVersionModel.findById.mockResolvedValueOnce(version);
    mockParserRegistry.resolve.mockReturnValueOnce(
      buildStubParser([
        {
          text: 'Some extracted page text.',
          locator: {
            kind: 'pdf-page',
            page: 1,
            boundingBox: { x: 0, y: 0, width: 10, height: 10 },
            extractorVersion: 'pdf-pdfjs-1',
          },
          headingPath: [],
        },
      ]),
    );

    const result = await service.ingestVersion(versionId.toString());

    expect(mockParserRegistry.resolve).toHaveBeenCalledWith(PDF_MIME);
    expect(fakeEmbeddingProvider.calls).toHaveLength(1);
    expect(fakeEmbeddingProvider.calls[0].inputType).toBe('document');
    expect(fakeEmbeddingProvider.calls[0].inputs).toEqual(['Some extracted page text.']);
    expect(mockEvidenceChunkModel.insertMany).toHaveBeenCalledTimes(1);
    // `getMockModel`'s `insertMany` is typed only on its return value, so `.mock.calls` comes
    // back untyped — recast the mock itself with the call-argument shape this test needs before
    // indexing into it, rather than casting the indexed result (which is what trips
    // `no-unsafe-member-access`).
    const insertManyMock = mockEvidenceChunkModel.insertMany as jest.Mock<
      Promise<unknown[]>,
      [
        {
          documentId: Types.ObjectId;
          documentVersionId: Types.ObjectId;
          text: string;
          tenantId: string;
          locator: { kind: string; page: number };
          embedding: number[];
        }[],
      ]
    >;
    const insertedChunks = insertManyMock.mock.calls[0][0];
    expect(insertedChunks).toHaveLength(1);
    expect(insertedChunks[0].documentId).toBe(documentId);
    expect(insertedChunks[0].documentVersionId).toBe(versionId);
    expect(insertedChunks[0].text).toBe('Some extracted page text.');
    expect(insertedChunks[0].tenantId).toBe('default');
    expect(insertedChunks[0].locator).toEqual(
      expect.objectContaining({ kind: 'pdf-page', page: 1 }),
    );
    expect(insertedChunks[0].embedding).toHaveLength(fakeEmbeddingProvider.info.dimensions);
    expect(result).toEqual({ chunksCreated: 1, alreadyIngested: false });

    const [finalizeFilter, finalizeUpdate] = getFindOneAndUpdateCall(2);
    expect(finalizeFilter._id).toBe(versionId);
    expect(finalizeFilter.ingestionLeaseToken).toBeInstanceOf(Types.ObjectId);
    expect(finalizeUpdate).toEqual({
      $set: { ingestionStatus: 'completed' },
      $unset: { ingestionLeaseToken: '' },
    });
  });

  it('should skip re-ingestion without deleting chunks when a concurrent attempt already completed the version between the read and the claim', async () => {
    // Regression for the interleave in FIX 2: Temporal's at-least-once retries mean a second
    // attempt can start while a first, timed-out-from-Temporal's-perspective attempt is still
    // running. Reading `pending` is stale the instant a concurrent attempt finishes — only an
    // atomic claim (not the earlier plain read) may authorize the recovery `deleteMany` below.
    mockDocumentVersionModel.findById.mockResolvedValueOnce(buildVersion());
    mockDocumentVersionModel.findOneAndUpdate.mockResolvedValueOnce(null);

    const result = await service.ingestVersion(versionId.toString());

    expect(result).toEqual({ chunksCreated: 0, alreadyIngested: true });

    const [claimFilter, claimUpdate] = getFindOneAndUpdateCall(1);
    expect(claimFilter).toEqual({ _id: versionId, ingestionStatus: { $ne: 'completed' } });
    const claimSet = claimUpdate.$set as Record<string, unknown>;
    expect(Object.keys(claimUpdate)).toEqual(['$set']);
    expect(Object.keys(claimSet)).toEqual(['ingestionLeaseToken']);
    expect(claimSet.ingestionLeaseToken).toBeInstanceOf(Types.ObjectId);
    expect(mockEvidenceChunkModel.deleteMany).not.toHaveBeenCalled();
    expect(mockEvidenceChunkModel.insertMany).not.toHaveBeenCalled();
  });

  it('should roll back nothing but report itself superseded when a newer attempt claims the lease before a zero-chunk version finalizes', async () => {
    const stored = await fakeDocumentStore.put({
      content: Buffer.from('%PDF-empty'),
      contentType: PDF_MIME,
      metadata: {},
    });
    const version = buildVersion({ storageKey: stored.id });
    mockDocumentVersionModel.findById.mockResolvedValueOnce(version);
    mockDocumentVersionModel.findOneAndUpdate
      .mockResolvedValueOnce(version) // claim succeeds
      .mockResolvedValueOnce(null); // finalize loses the race to a newer attempt
    mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([]));

    const result = await service.ingestVersion(versionId.toString());

    expect(result).toEqual({ chunksCreated: 0, alreadyIngested: true });
    // Only the pre-ingest recovery cleanup — nothing was inserted this attempt, so there is
    // nothing to roll back.
    expect(mockEvidenceChunkModel.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("should roll back only its own newly inserted chunks, by id, when a newer attempt claims the lease before this attempt's chunks finalize", async () => {
    const stored = await fakeDocumentStore.put({
      content: Buffer.from('%PDF-1.4 fixture bytes'),
      contentType: PDF_MIME,
      metadata: {},
    });
    const version = buildVersion({ storageKey: stored.id });
    mockDocumentVersionModel.findById.mockResolvedValueOnce(version);
    mockDocumentVersionModel.findOneAndUpdate
      .mockResolvedValueOnce(version) // claim succeeds
      .mockResolvedValueOnce(null); // finalize loses the race to a newer attempt
    mockParserRegistry.resolve.mockReturnValueOnce(
      buildStubParser([
        {
          text: 'Some extracted page text.',
          locator: { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-pdfjs-1' },
          headingPath: [],
        },
      ]),
    );

    const result = await service.ingestVersion(versionId.toString());

    expect(result).toEqual({ chunksCreated: 0, alreadyIngested: true });
    expect(mockEvidenceChunkModel.insertMany).toHaveBeenCalledTimes(1);
    expect(mockEvidenceChunkModel.deleteMany).toHaveBeenCalledTimes(2);

    const insertManyMock = mockEvidenceChunkModel.insertMany as jest.Mock<
      Promise<unknown[]>,
      [{ _id: Types.ObjectId }[]]
    >;
    const insertedId = insertManyMock.mock.calls[0][0][0]._id;

    const deleteManyMock = mockEvidenceChunkModel.deleteMany as jest.Mock<
      Promise<unknown>,
      [{ documentVersionId?: Types.ObjectId; _id?: { $in: Types.ObjectId[] } }]
    >;
    expect(deleteManyMock.mock.calls[0][0]).toEqual({ documentVersionId: versionId });
    // Rolled back by the exact id this attempt inserted, not the whole version's chunks — a
    // concurrent, winning attempt's own rows must survive this call.
    const rollbackFilter = deleteManyMock.mock.calls[1][0];
    expect(rollbackFilter._id?.$in).toHaveLength(1);
    expect(rollbackFilter._id?.$in[0].equals(insertedId)).toBe(true);
  });

  it('should roll back and rethrow when the chunk insert fails partway', async () => {
    // Without the rollback, `ingestionStatus` never reaches `completed` and the next retry sees
    // half-ingested chunks with no marker distinguishing them from a finished ingest — silently
    // wrong rather than loudly broken. This is exactly the defect `ingestionStatus` exists to
    // make detectable (see `IngestionService.ingestVersion`'s doc comment).
    const stored = await fakeDocumentStore.put({
      content: Buffer.from('%PDF-1.4 fixture bytes'),
      contentType: PDF_MIME,
      metadata: {},
    });
    const version = buildVersion({ storageKey: stored.id });
    mockDocumentVersionModel.findById.mockResolvedValueOnce(version);
    mockParserRegistry.resolve.mockReturnValueOnce(
      buildStubParser([
        {
          text: 'Some extracted page text.',
          locator: { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-pdfjs-1' },
          headingPath: [],
        },
      ]),
    );

    const writeFailure = new Error('write concern failed');
    mockEvidenceChunkModel.insertMany.mockRejectedValueOnce(writeFailure);

    await expect(service.ingestVersion(versionId.toString())).rejects.toBe(writeFailure);

    // Called twice for this version: once as the pre-ingest recovery cleanup (scoped to the whole
    // version), once as the post-failure rollback (scoped to the ids this attempt tried to
    // insert — see the lease-race tests above for why the two must differ).
    expect(mockEvidenceChunkModel.deleteMany).toHaveBeenCalledTimes(2);
    const deleteManyMock = mockEvidenceChunkModel.deleteMany as jest.Mock<
      Promise<unknown>,
      [{ documentVersionId?: Types.ObjectId; _id?: { $in: Types.ObjectId[] } }]
    >;
    expect(deleteManyMock.mock.calls[0][0]).toEqual({ documentVersionId: versionId });
    expect(deleteManyMock.mock.calls[1][0]._id?.$in).toHaveLength(1);
    expect(mockDocumentVersionModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
