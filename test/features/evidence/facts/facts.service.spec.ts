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

  it("should skip extraction and leave the store untouched, returning the existing facts' keys, when facts already exist for the version", async () => {
    mockDocumentVersionModel.findById.mockResolvedValueOnce(buildVersion());
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    mockExtractedFactModel.find.mockResolvedValueOnce([{ factKey }]);
    const getSpy = jest.spyOn(fakeDocumentStore, 'get');

    const result = await service.extractFacts(versionId.toString());

    // The tenant predicate is explicit because extraction runs in worker context, where
    // `tenantScopePlugin` does not backstop a missing one. Without it, this query would return
    // another tenant's facts for the same version id and hand their keys to the conflict scan.
    expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
      { documentVersionId: versionId, tenantId: 'default' },
      { factKey: 1 },
    );
    expect(result).toEqual({
      factsCreated: 0,
      alreadyExtracted: true,
      skippedChunkCount: 0,
      factKeys: [factKey],
    });
    expect(getSpy).not.toHaveBeenCalled();
    expect(mockExtractedFactModel.insertMany).not.toHaveBeenCalled();
  });

  it('should throw InternalServerErrorException when the store has no bytes for a recorded storageKey', async () => {
    mockDocumentVersionModel.findById.mockResolvedValueOnce(
      buildVersion({ storageKey: 'missing-key' }),
    );
    mockExtractedFactModel.find.mockResolvedValueOnce([]);

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
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
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
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser(xlsxElements));
      const chunkId = 'chunk-xlsx-region-1';
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
            chunkId: string;
            documentVersionId: Types.ObjectId;
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
      // Regression: `documentVersionId` must be on the inserted document, or the idempotency
      // check and rollback filters (both scoped by this field) never match anything they wrote.
      expect(insertedFacts[0].documentVersionId).toBe(versionId);
      expect(insertedFacts[0].tenantId).toBe('default');
      expect(result).toEqual({
        factsCreated: 1,
        alreadyExtracted: false,
        skippedChunkCount: 0,
        factKeys: [insertedFacts[0].factKey],
      });
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
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser(xlsxElements));
      // Region covers rows 20-30; the candidate cell is on row 2 — no chunk contains it.
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        {
          _id: new Types.ObjectId(),
          locator: { kind: 'xlsx-region', sheetName: SHEET_NAME, range: 'A20:C30' },
        },
      ]);

      const result = await service.extractFacts(versionId.toString());

      expect(result).toEqual({
        factsCreated: 0,
        alreadyExtracted: false,
        skippedChunkCount: 0,
        factKeys: [],
      });
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
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
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
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([buildProseElement()]));
      const chunkId = 'chunk-prose-1';
      const chunkText = 'The cap rate is 5.25% per the offering memo.';
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        { _id: chunkId, text: chunkText, locator: { kind: 'pdf-page', page: 1 } },
      ]);
      const modelOutput = {
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
      };
      // All 3 passes return the same output — 3-of-3 unanimous agreement on the grounded
      // candidate, matching this suite's other tests of the single-pass accept/reject split.
      fakeModelProvider.enqueueResult(modelOutput);
      fakeModelProvider.enqueueResult(modelOutput);
      fakeModelProvider.enqueueResult(modelOutput);
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);

      const result = await service.extractFacts(versionId.toString());

      expect(fakeModelProvider.calls).toHaveLength(3);
      expect(fakeModelProvider.calls[0].taskClass).toBe('fact_extraction');
      expect(fakeModelProvider.calls[0].messages[0].content).toBe(chunkText);
      const insertManyMock = mockExtractedFactModel.insertMany as jest.Mock<
        Promise<unknown[]>,
        [
          {
            factKey: { entity: string; metric: string; period: string };
            value: { amount: number; unit: string };
            rawText: string;
            chunkId: string;
            documentVersionId: Types.ObjectId;
          }[],
        ]
      >;
      const insertedFacts = insertManyMock.mock.calls[0][0];
      expect(insertedFacts).toHaveLength(1);
      expect(insertedFacts[0].rawText).toBe('cap rate is 5.25%');
      expect(insertedFacts[0].chunkId).toBe(chunkId);
      expect(insertedFacts[0].documentVersionId).toBe(versionId);
      // Confirms the ungrounded candidate's rejection reached the service's own logging, not just
      // `extractProseFacts`'s internal bookkeeping.
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining(`Dropped fact candidate for chunk '${chunkId}'`),
      );
      expect(result).toEqual({
        factsCreated: 1,
        alreadyExtracted: false,
        skippedChunkCount: 0,
        factKeys: [insertedFacts[0].factKey],
      });
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
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([]));
      const chunkId = new Types.ObjectId();
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        {
          _id: chunkId,
          text: 'A chunk with no extractable facts.',
          locator: { kind: 'pdf-page', page: 1 },
        },
      ]);
      // All 3 passes agree there is nothing here — a valid unanimous "no facts" outcome, not a
      // low-agreement skip.
      fakeModelProvider.enqueueResult({ output: { facts: [] } });
      fakeModelProvider.enqueueResult({ output: { facts: [] } });
      fakeModelProvider.enqueueResult({ output: { facts: [] } });

      const result = await service.extractFacts(versionId.toString());

      expect(fakeModelProvider.calls).toHaveLength(3);
      expect(result).toEqual({
        factsCreated: 0,
        alreadyExtracted: false,
        skippedChunkCount: 0,
        factKeys: [],
      });
      expect(mockExtractedFactModel.insertMany).not.toHaveBeenCalled();
    });

    it('should skip a chunk visibly, counted and logged at warn, when fewer than 2 of 3 extraction passes succeed', async () => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('%PDF-1.4 fixture bytes'),
        contentType: PDF_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findById.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([buildProseElement()]));
      const chunkId = 'chunk-prose-flaky';
      const chunkText = 'The cap rate is 5.25% per the offering memo.';
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        { _id: chunkId, text: chunkText, locator: { kind: 'pdf-page', page: 1 } },
      ]);
      // Only 1 of 3 passes returns a queued result — `FakeModelProvider` throws on the other 2
      // (queue exhausted), so successfulPassCount === 1 regardless of how grounded that one
      // pass's candidate is.
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
          ],
        },
      });

      const result = await service.extractFacts(versionId.toString());

      expect(fakeModelProvider.calls).toHaveLength(3);
      expect(result).toEqual({
        factsCreated: 0,
        alreadyExtracted: false,
        skippedChunkCount: 1,
        factKeys: [],
      });
      expect(mockExtractedFactModel.insertMany).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Chunk '${chunkId}' had only 1 of 3 successful extraction passes`),
      );
    });
  });

  describe('findCellFacts', () => {
    it('should return an empty array without querying the model when chunkIds is empty', async () => {
      const result = await service.findCellFacts([], 'acme-corp');

      expect(result).toEqual([]);
      expect(mockExtractedFactModel.find).not.toHaveBeenCalled();
    });

    it('should query every given chunk id verbatim, scoped to tenant and xlsx-cell locators', async () => {
      // `chunkId` is now a content-addressed string (`computeChunkId`), not an ObjectId, so there
      // is no "invalid ObjectId" shape to filter out any more — every id a caller supplies is
      // passed straight through to the query.
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      const result = await service.findCellFacts(['chunk-a', 'chunk-b'], 'acme-corp');

      expect(mockExtractedFactModel.find).toHaveBeenCalledWith({
        chunkId: { $in: ['chunk-a', 'chunk-b'] },
        tenantId: 'acme-corp',
        'locator.kind': 'xlsx-cell',
      });
      expect(result).toEqual([]);
    });

    it('should return the xlsx-cell facts scoped to the given chunks and tenant', async () => {
      const chunkId = 'chunk-xlsx-cell-1';
      const facts = [
        {
          _id: new Types.ObjectId(),
          chunkId,
          factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
          value: { amount: 5.25, unit: 'percent' },
          locator: { kind: 'xlsx-cell', sheetName: SHEET_NAME, cell: 'F2', extractorVersion: 'v1' },
        },
      ];
      mockExtractedFactModel.find.mockResolvedValueOnce(facts);

      const result = await service.findCellFacts([chunkId], 'acme-corp');

      expect(result).toEqual(facts);
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
    mockExtractedFactModel.find.mockResolvedValueOnce([]);
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
