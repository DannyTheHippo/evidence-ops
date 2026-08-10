import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { EvidenceChunk } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { DocumentVersionNotFoundException } from '../../../../src/features/evidence/facts/exceptions/facts.exception';
import { FactsService } from '../../../../src/features/evidence/facts/facts.service';
import { ParserRegistry } from '../../../../src/features/evidence/ingestion/parser.registry';
import type {
  DocumentParser,
  ParsedElement,
} from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import { MODEL_PROVIDER } from '../../../../src/providers/model/model-provider.interface';
import { FakeModelProvider } from '../../../../src/providers/model/fake-model.provider';
import { DOCUMENT_STORE } from '../../../../src/providers/storage/document-store.interface';
import { FakeDocumentStore } from '../../../../src/providers/storage/fake-document.store';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('FactsService', () => {
  let service: FactsService;
  let fakeDocumentStore: FakeDocumentStore;
  let fakeModelProvider: FakeModelProvider;
  let mockLogger: ReturnType<typeof getMockLogger>;

  const mockDocumentVersionModel = getMockModel();
  const mockEvidenceChunkModel = getMockModel();
  const mockExtractedFactModel = getMockModel();
  const mockParserRegistry = { resolve: jest.fn() } satisfies Record<
    keyof Pick<ParserRegistry, 'resolve'>,
    jest.Mock
  >;

  const versionId = new Types.ObjectId();
  const documentId = new Types.ObjectId();
  const PDF_MIME = 'application/pdf';
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const SHEET_NAME = 'Comps';

  const buildVersion = (overrides: Record<string, unknown> = {}) => ({
    _id: versionId,
    documentId,
    storageKey: 'not-set',
    tenantId: 'default',
    ...overrides,
  });

  const buildStubParser = (elements: readonly ParsedElement[]): DocumentParser => ({
    supports: [PDF_MIME, XLSX_MIME],
    parse: jest.fn().mockResolvedValue({ elements, extractorVersion: 'test-extractor-1' }),
  });

  const buildXlsxElement = (cell: string, text: string): ParsedElement => ({
    text,
    locator: { kind: 'xlsx-cell', sheetName: SHEET_NAME, cell, extractorVersion: 'xlsx-1' },
    headingPath: [],
  });

  // Header row (Property Name / Cap Rate) plus one data row — enough for `extractXlsxFacts` to
  // emit exactly one real candidate without hand-building its output.
  const xlsxElements: ParsedElement[] = [
    buildXlsxElement('A1', 'Property Name'),
    buildXlsxElement('B1', 'Cap Rate'),
    buildXlsxElement('A2', 'Northgate Business Park'),
    buildXlsxElement('B2', '5.25%'),
  ];

  beforeEach(async () => {
    fakeDocumentStore = new FakeDocumentStore();
    fakeModelProvider = new FakeModelProvider();
    mockLogger = getMockLogger();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FactsService,
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: getModelToken(EvidenceChunk.name), useValue: mockEvidenceChunkModel },
        { provide: getModelToken(ExtractedFact.name), useValue: mockExtractedFactModel },
        { provide: DOCUMENT_STORE, useValue: fakeDocumentStore },
        { provide: MODEL_PROVIDER, useValue: fakeModelProvider },
        { provide: ParserRegistry, useValue: mockParserRegistry },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<FactsService>(FactsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should throw DocumentVersionNotFoundException for a malformed id, without querying the model', async () => {
    await expect(service.extractFacts('not-an-object-id')).rejects.toBeInstanceOf(
      DocumentVersionNotFoundException,
    );
    expect(mockDocumentVersionModel.findById).not.toHaveBeenCalled();
  });

  it('should throw DocumentVersionNotFoundException when the version does not exist', async () => {
    mockDocumentVersionModel.findById.mockResolvedValueOnce(null);

    await expect(service.extractFacts(versionId.toString())).rejects.toBeInstanceOf(
      DocumentVersionNotFoundException,
    );
  });

  it('should skip extraction and leave the store untouched when facts already exist for the version', async () => {
    mockDocumentVersionModel.findById.mockResolvedValueOnce(buildVersion());
    mockExtractedFactModel.countDocuments.mockResolvedValueOnce(3);
    const getSpy = jest.spyOn(fakeDocumentStore, 'get');

    const result = await service.extractFacts(versionId.toString());

    expect(result).toEqual({ factsCreated: 0, alreadyExtracted: true });
    expect(getSpy).not.toHaveBeenCalled();
    expect(mockExtractedFactModel.insertMany).not.toHaveBeenCalled();
  });

  it('should throw InternalServerErrorException when the store has no bytes for a recorded storageKey', async () => {
    mockDocumentVersionModel.findById.mockResolvedValueOnce(
      buildVersion({ storageKey: 'missing-key' }),
    );
    mockExtractedFactModel.countDocuments.mockResolvedValueOnce(0);

    await expect(service.extractFacts(versionId.toString())).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  describe('spreadsheet path', () => {
    it('should throw InternalServerErrorException when the version has no ingested chunks', async () => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('workbook-bytes'),
        contentType: XLSX_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findById.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.countDocuments.mockResolvedValueOnce(0);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser(xlsxElements));
      mockEvidenceChunkModel.find.mockResolvedValueOnce([]);

      await expect(service.extractFacts(versionId.toString())).rejects.toThrow(
        /no ingested chunks/,
      );
    });

    it('should resolve the containing chunk and persist a candidate for a cell inside an ingested region', async () => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('workbook-bytes'),
        contentType: XLSX_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findById.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.countDocuments.mockResolvedValueOnce(0);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser(xlsxElements));
      const chunkId = new Types.ObjectId();
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        {
          _id: chunkId,
          locator: { kind: 'xlsx-region', sheetName: SHEET_NAME, range: 'A1:C10' },
        },
      ]);
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);

      const result = await service.extractFacts(versionId.toString());

      expect(mockParserRegistry.resolve).toHaveBeenCalledWith(XLSX_MIME);
      expect(mockExtractedFactModel.insertMany).toHaveBeenCalledTimes(1);
      const insertManyMock = mockExtractedFactModel.insertMany as jest.Mock<
        Promise<unknown[]>,
        [
          {
            factKey: { entity: string; metric: string; period: string };
            value: { amount: number; unit: string };
            chunkId: Types.ObjectId;
            tenantId: string;
          }[],
        ]
      >;
      const insertedFacts = insertManyMock.mock.calls[0][0];
      expect(insertedFacts).toHaveLength(1);
      expect(insertedFacts[0].factKey).toEqual({
        entity: 'Northgate Business Park',
        metric: 'cap_rate',
        period: 'undated',
      });
      expect(insertedFacts[0].value).toEqual({ amount: 5.25, unit: 'percent' });
      expect(insertedFacts[0].chunkId).toBe(chunkId);
      expect(insertedFacts[0].tenantId).toBe('default');
      expect(result).toEqual({ factsCreated: 1, alreadyExtracted: false });
    });

    it('should drop a candidate whose cell falls outside every ingested chunk region', async () => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('workbook-bytes'),
        contentType: XLSX_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findById.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.countDocuments.mockResolvedValueOnce(0);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser(xlsxElements));
      // Region covers rows 20-30; the candidate cell is on row 2 — no chunk contains it.
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        {
          _id: new Types.ObjectId(),
          locator: { kind: 'xlsx-region', sheetName: SHEET_NAME, range: 'A20:C30' },
        },
      ]);

      const result = await service.extractFacts(versionId.toString());

      expect(result).toEqual({ factsCreated: 0, alreadyExtracted: false });
      expect(mockExtractedFactModel.insertMany).not.toHaveBeenCalled();
    });
  });

  describe('prose path', () => {
    const buildProseElement = (): ParsedElement => ({
      text: 'Full source paragraph text.',
      locator: { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-1' },
      headingPath: [],
    });

    it('should throw InternalServerErrorException when the version has no ingested chunks', async () => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('%PDF-1.4 fixture bytes'),
        contentType: PDF_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findById.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.countDocuments.mockResolvedValueOnce(0);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([buildProseElement()]));
      mockEvidenceChunkModel.find.mockResolvedValueOnce([]);

      await expect(service.extractFacts(versionId.toString())).rejects.toThrow(
        /no ingested chunks/,
      );
    });

    it('should accept a fact whose quote is grounded in the chunk and drop one whose quote is not', async () => {
      // The single most important guarantee of prose extraction: the model proposes, the
      // application disposes. Both an acceptable and an ungrounded candidate come back from one
      // model call so the accept/reject split is proven, not just the happy path.
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('%PDF-1.4 fixture bytes'),
        contentType: PDF_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findById.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.countDocuments.mockResolvedValueOnce(0);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([buildProseElement()]));
      const chunkId = new Types.ObjectId();
      const chunkText = 'The cap rate is 5.25% per the offering memo.';
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        { _id: chunkId, text: chunkText, locator: { kind: 'pdf-page', page: 1 } },
      ]);
      fakeModelProvider.enqueueResult({
        output: {
          facts: [
            {
              entity: 'Northgate Business Park',
              metric: 'cap_rate',
              periodText: '',
              amount: 5.25,
              unit: 'percent',
              quote: 'cap rate is 5.25%',
              confidence: 0.9,
            },
            {
              entity: 'Northgate Business Park',
              metric: 'cap_rate',
              periodText: '',
              amount: 6.0,
              unit: 'percent',
              quote: 'a quote that does not appear anywhere in the chunk',
              confidence: 0.9,
            },
          ],
        },
      });
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);

      const result = await service.extractFacts(versionId.toString());

      expect(fakeModelProvider.calls).toHaveLength(1);
      expect(fakeModelProvider.calls[0].taskClass).toBe('fact_extraction');
      expect(fakeModelProvider.calls[0].messages[0].content).toBe(chunkText);
      const insertManyMock = mockExtractedFactModel.insertMany as jest.Mock<
        Promise<unknown[]>,
        [
          {
            factKey: { entity: string; metric: string; period: string };
            value: { amount: number; unit: string };
            rawText: string;
            chunkId: Types.ObjectId;
          }[],
        ]
      >;
      const insertedFacts = insertManyMock.mock.calls[0][0];
      expect(insertedFacts).toHaveLength(1);
      expect(insertedFacts[0].rawText).toBe('cap rate is 5.25%');
      expect(insertedFacts[0].chunkId).toBe(chunkId);
      // Confirms the ungrounded candidate's rejection reached the service's own logging, not just
      // `extractProseFacts`'s internal bookkeeping.
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining(`Dropped fact candidate for chunk '${chunkId.toString()}'`),
      );
      expect(result).toEqual({ factsCreated: 1, alreadyExtracted: false });
    });

    it('should treat a version with zero parsed elements as prose and produce no facts when the model returns none', async () => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('%PDF-empty'),
        contentType: PDF_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findById.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.countDocuments.mockResolvedValueOnce(0);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([]));
      const chunkId = new Types.ObjectId();
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        {
          _id: chunkId,
          text: 'A chunk with no extractable facts.',
          locator: { kind: 'pdf-page', page: 1 },
        },
      ]);
      fakeModelProvider.enqueueResult({ output: { facts: [] } });

      const result = await service.extractFacts(versionId.toString());

      expect(fakeModelProvider.calls).toHaveLength(1);
      expect(result).toEqual({ factsCreated: 0, alreadyExtracted: false });
      expect(mockExtractedFactModel.insertMany).not.toHaveBeenCalled();
    });
  });

  it('should roll back and rethrow when the fact insert fails partway', async () => {
    const stored = await fakeDocumentStore.put({
      content: Buffer.from('workbook-bytes'),
      contentType: XLSX_MIME,
      metadata: {},
    });
    mockDocumentVersionModel.findById.mockResolvedValueOnce(
      buildVersion({ storageKey: stored.id }),
    );
    mockExtractedFactModel.countDocuments.mockResolvedValueOnce(0);
    mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser(xlsxElements));
    mockEvidenceChunkModel.find.mockResolvedValueOnce([
      {
        _id: new Types.ObjectId(),
        locator: { kind: 'xlsx-region', sheetName: SHEET_NAME, range: 'A1:C10' },
      },
    ]);
    const writeFailure = new Error('write concern failed');
    mockExtractedFactModel.insertMany.mockRejectedValueOnce(writeFailure);

    await expect(service.extractFacts(versionId.toString())).rejects.toBe(writeFailure);

    expect(mockExtractedFactModel.deleteMany).toHaveBeenCalledWith({
      documentVersionId: versionId,
    });
  });
});
