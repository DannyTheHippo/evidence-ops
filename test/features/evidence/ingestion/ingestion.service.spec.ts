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
    ...overrides,
  });

  const buildStubParser = (elements: ParsedDocument['elements']): DocumentParser => ({
    supports: [PDF_MIME],
    parse: jest.fn().mockResolvedValue({ elements, extractorVersion: 'pdf-pdfjs-1' }),
  });

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

  it('should skip re-ingestion and leave the store untouched when chunks already exist for the version', async () => {
    mockDocumentVersionModel.findById.mockResolvedValueOnce(buildVersion());
    mockEvidenceChunkModel.countDocuments.mockResolvedValueOnce(3);
    const getSpy = jest.spyOn(fakeDocumentStore, 'get');

    const result = await service.ingestVersion(versionId.toString());

    expect(result).toEqual({ chunksCreated: 0, alreadyIngested: true });
    expect(getSpy).not.toHaveBeenCalled();
    expect(mockEvidenceChunkModel.insertMany).not.toHaveBeenCalled();
  });

  it('should throw InternalServerErrorException when the store has no bytes for a recorded storageKey', async () => {
    mockDocumentVersionModel.findById.mockResolvedValueOnce(
      buildVersion({ storageKey: 'missing-key' }),
    );
    mockEvidenceChunkModel.countDocuments.mockResolvedValueOnce(0);

    await expect(service.ingestVersion(versionId.toString())).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('should return a no-op result when parsing yields no elements to chunk', async () => {
    const stored = await fakeDocumentStore.put({
      content: Buffer.from('%PDF-empty'),
      contentType: PDF_MIME,
      metadata: {},
    });
    mockDocumentVersionModel.findById.mockResolvedValueOnce(
      buildVersion({ storageKey: stored.id }),
    );
    mockEvidenceChunkModel.countDocuments.mockResolvedValueOnce(0);
    mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([]));

    const result = await service.ingestVersion(versionId.toString());

    expect(result).toEqual({ chunksCreated: 0, alreadyIngested: false });
    expect(fakeEmbeddingProvider.calls).toHaveLength(0);
    expect(mockEvidenceChunkModel.insertMany).not.toHaveBeenCalled();
  });

  it('should parse, chunk, embed as document input, and persist chunks for a new version', async () => {
    const stored = await fakeDocumentStore.put({
      content: Buffer.from('%PDF-1.4 fixture bytes'),
      contentType: PDF_MIME,
      metadata: {},
    });
    mockDocumentVersionModel.findById.mockResolvedValueOnce(
      buildVersion({ storageKey: stored.id }),
    );
    mockEvidenceChunkModel.countDocuments.mockResolvedValueOnce(0);
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
    mockEvidenceChunkModel.insertMany.mockResolvedValueOnce([]);

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
  });

  it('should roll back and rethrow when the chunk insert fails partway', async () => {
    // Without the rollback the existence check turns a transient write error into permanent
    // half-ingestion: a retry sees chunks present, skips, and the version serves a partial
    // evidence set forever — silently wrong rather than loudly broken.
    const stored = await fakeDocumentStore.put({
      content: Buffer.from('%PDF-1.4 fixture bytes'),
      contentType: PDF_MIME,
      metadata: {},
    });
    mockDocumentVersionModel.findById.mockResolvedValueOnce(
      buildVersion({ storageKey: stored.id }),
    );
    mockEvidenceChunkModel.countDocuments.mockResolvedValueOnce(0);
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

    expect(mockEvidenceChunkModel.deleteMany).toHaveBeenCalledWith({
      documentVersionId: versionId,
    });
  });
});
