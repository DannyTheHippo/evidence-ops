import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { TypedConfigService } from '../../../../src/config/environment/typed-config.service';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { EvidenceChunk } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { CanonicalEntityResolution } from '../../../../src/features/evidence/facts/canonical-entity.service';
import { CanonicalEntityService } from '../../../../src/features/evidence/facts/canonical-entity.service';
import { DocumentVersionNotFoundException } from '../../../../src/features/evidence/facts/exceptions/facts.exception';
import { FactsService } from '../../../../src/features/evidence/facts/facts.service';
import {
  ACTIVE_PACK_ID,
  ACTIVE_PACK_VERSION,
} from '../../../../src/features/evidence/facts/metric-ontology';
import { MetricPacksService } from '../../../../src/features/evidence/facts/metric-packs.service';
import { CRE_PACK_V1 } from '../../../../src/features/evidence/facts/packs/cre.pack';
import { PASS_COUNT } from '../../../../src/features/evidence/facts/prose-fact-extractor';
import { ParserRegistry } from '../../../../src/features/evidence/ingestion/parser.registry';
import type {
  DocumentParser,
  ParsedElement,
} from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import { EVIDENCE_DELIMITER_TAG } from '../../../../src/features/evidence/ingestion/sanitize-evidence-text';
import type { z } from 'zod/v4';
import {
  MODEL_PROVIDER,
  type ModelProvider,
  type ModelProviderInfo,
  type ModelRequest,
  type ModelResult,
} from '../../../../src/providers/model/model-provider.interface';
import { FakeModelProvider } from '../../../../src/providers/model/fake-model.provider';
import { DOCUMENT_STORE } from '../../../../src/providers/storage/document-store.interface';
import { FakeDocumentStore } from '../../../../src/providers/storage/fake-document.store';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';
import { getMockTypedConfig } from '../../../utils/get-mock-typed-config';

/**
 * Lets every already-scheduled microtask and timer callback run, so an assertion made after it
 * observes the extraction pool at rest rather than mid-flush.
 */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * `ModelProvider` whose calls stay pending until `releaseAll()`, so a test can observe exactly
 * which chunks the extraction pool has started before any of them settle. `FakeModelProvider`
 * cannot serve this: it resolves synchronously, so every chunk's passes have already completed by
 * the time a test regains control and the pool's width is unobservable.
 */
class GatedModelProvider implements ModelProvider {
  readonly info: ModelProviderInfo = { provider: 'gated', model: 'gated-model' };
  readonly calls: ModelRequest[] = [];

  private readonly pending: (() => void)[] = [];

  constructor(private readonly outputFor: (chunkText: string) => unknown) {}

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    this.calls.push(request);
    const chunkText = request.messages[0].content;

    await new Promise<void>((resolve) => this.pending.push(resolve));

    return {
      output: this.outputFor(chunkText),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      costUsd: 0,
    } as ModelResult<TSchema>;
  }

  releaseAll(): void {
    for (const resolve of this.pending.splice(0)) {
      resolve();
    }
  }
}

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
  // Every real assertion this suite makes is about extraction, not canonicalization —
  // `beforeEach` defaults every name to unmatched-and-unchanged so those assertions
  // (`factKey.entity` equal to the raw extracted name) hold without each test arranging the
  // registry itself. Tests that care about canonicalization override the implementation per-call.
  const mockCanonicalEntityService = {
    resolveMany: jest.fn(),
  } satisfies Record<keyof Pick<CanonicalEntityService, 'resolveMany'>, jest.Mock>;
  // Every test in this suite runs a tenant with no authored `MetricPack` row, so extraction always
  // resolves to the code default — `beforeEach` re-arms this to `CRE_PACK_V1` after each
  // `resetAllMocks`, matching `MetricPacksService.resolveActive`'s own fallback.
  const mockMetricPacksService = {
    resolveActive: jest.fn(),
  } satisfies Record<keyof Pick<MetricPacksService, 'resolveActive'>, jest.Mock>;

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

  const buildService = async (
    options: { chunkConcurrency?: number; modelProvider?: ModelProvider } = {},
  ): Promise<FactsService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FactsService,
        { provide: getModelToken(DocumentVersion.name), useValue: mockDocumentVersionModel },
        { provide: getModelToken(EvidenceChunk.name), useValue: mockEvidenceChunkModel },
        { provide: getModelToken(ExtractedFact.name), useValue: mockExtractedFactModel },
        { provide: DOCUMENT_STORE, useValue: fakeDocumentStore },
        { provide: MODEL_PROVIDER, useValue: options.modelProvider ?? fakeModelProvider },
        { provide: ParserRegistry, useValue: mockParserRegistry },
        { provide: CanonicalEntityService, useValue: mockCanonicalEntityService },
        { provide: MetricPacksService, useValue: mockMetricPacksService },
        {
          provide: TypedConfigService,
          useValue: getMockTypedConfig({
            extraction: { chunkConcurrency: options.chunkConcurrency ?? 2 },
          }),
        },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    return module.get<FactsService>(FactsService);
  };

  beforeEach(async () => {
    fakeDocumentStore = new FakeDocumentStore();
    fakeModelProvider = new FakeModelProvider();
    mockLogger = getMockLogger();
    // `resetAllMocks` (afterEach, below) wipes this implementation along with every other mock's,
    // so it is re-armed here rather than only at declaration.
    mockCanonicalEntityService.resolveMany.mockImplementation((rawNames: readonly string[]) =>
      Promise.resolve(
        rawNames.map((name): CanonicalEntityResolution => ({ name, matched: false })),
      ),
    );
    mockMetricPacksService.resolveActive.mockResolvedValue(CRE_PACK_V1);

    service = await buildService();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should throw DocumentVersionNotFoundException for a malformed id, without querying the model', async () => {
    await expect(service.extractFacts('not-an-object-id', 'default')).rejects.toBeInstanceOf(
      DocumentVersionNotFoundException,
    );
    expect(mockDocumentVersionModel.findOne).not.toHaveBeenCalled();
  });

  it('should throw DocumentVersionNotFoundException, scoped to the given tenantId, when no version matches', async () => {
    mockDocumentVersionModel.findOne.mockResolvedValueOnce(null);

    await expect(service.extractFacts(versionId.toString(), 'default')).rejects.toBeInstanceOf(
      DocumentVersionNotFoundException,
    );
    // Same "no row for this filter" branch a cross-tenant id would fall into: the id could exist
    // under a different tenant and this lookup would still — correctly — see nothing.
    expect(mockDocumentVersionModel.findOne).toHaveBeenCalledWith({
      _id: versionId.toString(),
      tenantId: 'default',
    });
  });

  it("should skip extraction and leave the store untouched, returning the existing facts' keys, when facts already exist for the version", async () => {
    mockDocumentVersionModel.findOne.mockResolvedValueOnce(buildVersion());
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    mockExtractedFactModel.find.mockResolvedValueOnce([{ factKey }]);
    const getSpy = jest.spyOn(fakeDocumentStore, 'get');

    const result = await service.extractFacts(versionId.toString(), 'default');

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
    mockDocumentVersionModel.findOne.mockResolvedValueOnce(
      buildVersion({ storageKey: 'missing-key' }),
    );
    mockExtractedFactModel.find.mockResolvedValueOnce([]);

    await expect(service.extractFacts(versionId.toString(), 'default')).rejects.toBeInstanceOf(
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
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser(xlsxElements));
      mockEvidenceChunkModel.find.mockResolvedValueOnce([]);

      await expect(service.extractFacts(versionId.toString(), 'default')).rejects.toThrow(
        /no ingested chunks/,
      );
    });

    it('should resolve the containing chunk and persist a candidate for a cell inside an ingested region', async () => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('workbook-bytes'),
        contentType: XLSX_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
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

      const result = await service.extractFacts(versionId.toString(), 'default');

      expect(mockParserRegistry.resolve).toHaveBeenCalledWith(XLSX_MIME);
      // The chunk lookup that resolves each candidate's containing region must carry the same
      // tenant predicate the version lookup did — an unscoped `find` here would let a candidate
      // resolve against another tenant's chunks sharing the same `documentVersionId`.
      expect(mockEvidenceChunkModel.find).toHaveBeenCalledWith({
        documentVersionId: versionId,
        tenantId: 'default',
      });
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
            packId: string;
            packVersion: number;
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
      expect(insertedFacts[0].packId).toBe(ACTIVE_PACK_ID);
      expect(insertedFacts[0].packVersion).toBe(ACTIVE_PACK_VERSION);
      expect(result).toEqual({
        factsCreated: 1,
        alreadyExtracted: false,
        skippedChunkCount: 0,
        factKeys: [insertedFacts[0].factKey],
      });
    });

    it('should persist observedAt from a row whose as-of column states a complete calendar date', async () => {
      const datedXlsxElements: ParsedElement[] = [
        buildXlsxElement('A1', 'Property Name'),
        buildXlsxElement('B1', 'As Of'),
        buildXlsxElement('C1', 'Cap Rate'),
        buildXlsxElement('A2', 'Northgate Business Park'),
        buildXlsxElement('B2', '2025-03-14'),
        buildXlsxElement('C2', '5.25%'),
      ];
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('workbook-bytes'),
        contentType: XLSX_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser(datedXlsxElements));
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        {
          _id: 'chunk-xlsx-region-dated',
          locator: { kind: 'xlsx-region', sheetName: SHEET_NAME, range: 'A1:C10' },
        },
      ]);
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);

      await service.extractFacts(versionId.toString(), 'default');

      const insertManyMock = mockExtractedFactModel.insertMany as jest.Mock<
        Promise<unknown[]>,
        [{ observedAt?: Date }[]]
      >;
      const insertedFacts = insertManyMock.mock.calls[0][0];
      expect(insertedFacts).toHaveLength(1);
      expect(insertedFacts[0].observedAt?.toISOString()).toBe('2025-03-14T00:00:00.000Z');
    });

    it('should drop a candidate whose cell falls outside every ingested chunk region', async () => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('workbook-bytes'),
        contentType: XLSX_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
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

      const result = await service.extractFacts(versionId.toString(), 'default');

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
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([buildProseElement()]));
      mockEvidenceChunkModel.find.mockResolvedValueOnce([]);

      await expect(service.extractFacts(versionId.toString(), 'default')).rejects.toThrow(
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
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
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
              observedAtText: '',
              amount: 5.25,
              unit: 'percent',
              quote: 'cap rate is 5.25%',
              confidence: 0.9,
            },
            {
              entity: 'Northgate Business Park',
              metric: 'cap_rate',
              periodText: '',
              observedAtText: '',
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

      const result = await service.extractFacts(versionId.toString(), 'default');

      // Same tenant predicate the xlsx path's chunk lookup carries — the prose builder queries
      // the same `EvidenceChunk` collection and must not fall back to an unscoped read.
      expect(mockEvidenceChunkModel.find).toHaveBeenCalledWith({
        documentVersionId: versionId,
        tenantId: 'default',
      });
      expect(fakeModelProvider.calls).toHaveLength(3);
      expect(fakeModelProvider.calls[0].taskClass).toBe('fact_extraction');
      expect(fakeModelProvider.calls[0].messages[0].content).toBe(
        `<${EVIDENCE_DELIMITER_TAG}>\n${chunkText}\n</${EVIDENCE_DELIMITER_TAG}>`,
      );
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
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
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

      const result = await service.extractFacts(versionId.toString(), 'default');

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
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
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
              observedAtText: '',
              amount: 5.25,
              unit: 'percent',
              quote: 'cap rate is 5.25%',
              confidence: 0.9,
            },
          ],
        },
      });

      const result = await service.extractFacts(versionId.toString(), 'default');

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

    /**
     * Chunk texts and the unanimous 3-pass model output for each, for the two multi-chunk tests
     * below. Both chunks carry the same metric and differ by entity so neither can be mistaken
     * for the other's candidate, and each quote is an exact substring of its own chunk's text —
     * the grounding check is what decides whether a candidate survives.
     */
    const CHUNK_A = {
      id: 'chunk-prose-a',
      text: 'The cap rate is 5.25% per the offering memo.',
      quote: 'cap rate is 5.25%',
      entity: 'Northgate Business Park',
      amount: 5.25,
    };
    const CHUNK_B = {
      id: 'chunk-prose-b',
      text: 'The cap rate is 6.10% for Southgate Plaza.',
      quote: 'cap rate is 6.10%',
      entity: 'Southgate Plaza',
      amount: 6.1,
    };

    const buildProseOutput = (chunk: typeof CHUNK_A) => ({
      output: {
        facts: [
          {
            entity: chunk.entity,
            metric: 'cap_rate',
            periodText: '',
            observedAtText: '',
            amount: chunk.amount,
            unit: 'percent',
            quote: chunk.quote,
            confidence: 0.9,
          },
        ],
      },
    });

    const arrangeTwoChunkVersion = async (): Promise<void> => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('%PDF-1.4 fixture bytes'),
        contentType: PDF_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([buildProseElement()]));
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        { _id: CHUNK_A.id, text: CHUNK_A.text, locator: { kind: 'pdf-page', page: 1 } },
        { _id: CHUNK_B.id, text: CHUNK_B.text, locator: { kind: 'pdf-page', page: 2 } },
      ]);
    };

    it("should tie each chunk's facts to the chunk they were extracted from when chunks are extracted concurrently", async () => {
      await arrangeTwoChunkVersion();
      for (let pass = 0; pass < 3; pass++) {
        fakeModelProvider.enqueueResult(buildProseOutput(CHUNK_A));
      }
      for (let pass = 0; pass < 3; pass++) {
        fakeModelProvider.enqueueResult(buildProseOutput(CHUNK_B));
      }
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);

      const result = await service.extractFacts(versionId.toString(), 'default');

      const insertManyMock = mockExtractedFactModel.insertMany as jest.Mock<
        Promise<unknown[]>,
        [{ factKey: { entity: string }; rawText: string; chunkId: string }[]]
      >;
      const insertedFacts = insertManyMock.mock.calls[0][0];
      expect(insertedFacts).toHaveLength(2);
      const byChunkId = new Map(insertedFacts.map((fact) => [fact.chunkId, fact]));
      expect(byChunkId.get(CHUNK_A.id)?.rawText).toBe(CHUNK_A.quote);
      expect(byChunkId.get(CHUNK_A.id)?.factKey.entity).toBe(CHUNK_A.entity);
      expect(byChunkId.get(CHUNK_B.id)?.rawText).toBe(CHUNK_B.quote);
      expect(byChunkId.get(CHUNK_B.id)?.factKey.entity).toBe(CHUNK_B.entity);
      expect(result.factsCreated).toBe(2);
      // Resolved once per extraction, not once per chunk — two chunks' worth of passes must not
      // have queried the tenant's active pack twice.
      expect(mockMetricPacksService.resolveActive).toHaveBeenCalledTimes(1);
      expect(mockMetricPacksService.resolveActive).toHaveBeenCalledWith('default');
    });

    it('should start no more chunks at once than config.extraction.chunkConcurrency allows', async () => {
      // Containment, not equality: the user turn arrives fenced in evidence delimiters, and this
      // callback only needs to identify which chunk it was handed.
      const gatedProvider = new GatedModelProvider((chunkText) =>
        chunkText.includes(CHUNK_A.text)
          ? buildProseOutput(CHUNK_A).output
          : buildProseOutput(CHUNK_B).output,
      );
      service = await buildService({ chunkConcurrency: 1, modelProvider: gatedProvider });
      await arrangeTwoChunkVersion();
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);

      const extraction = service.extractFacts(versionId.toString(), 'default');
      await flushMicrotasks();

      /**
       * With a pool of 1 the second chunk must not have been touched yet: every started call so
       * far belongs to chunk A. A pool that ignored the configured limit would already have
       * issued chunk B's passes here, because nothing has been released.
       */
      expect(gatedProvider.calls).toHaveLength(PASS_COUNT);
      const fencedChunkA = `<${EVIDENCE_DELIMITER_TAG}>\n${CHUNK_A.text}\n</${EVIDENCE_DELIMITER_TAG}>`;
      expect(gatedProvider.calls.every((call) => call.messages[0].content === fencedChunkA)).toBe(
        true,
      );

      gatedProvider.releaseAll();
      await flushMicrotasks();

      expect(gatedProvider.calls).toHaveLength(PASS_COUNT * 2);
      expect(
        gatedProvider.calls
          .slice(PASS_COUNT)
          .every(
            (c) =>
              c.messages[0].content ===
              `<${EVIDENCE_DELIMITER_TAG}>\n${CHUNK_B.text}\n</${EVIDENCE_DELIMITER_TAG}>`,
          ),
      ).toBe(true);

      gatedProvider.releaseAll();
      await expect(extraction).resolves.toMatchObject({ factsCreated: 2 });
    });
  });

  describe('entity canonicalization', () => {
    const buildProseElement = (): ParsedElement => ({
      text: 'Full source paragraph text.',
      locator: { kind: 'pdf-page', page: 1, extractorVersion: 'pdf-1' },
      headingPath: [],
    });

    const buildProseOutput = (entity: string, amount: number, quote: string) => ({
      output: {
        facts: [
          {
            entity,
            metric: 'cap_rate',
            periodText: '',
            observedAtText: '',
            amount,
            unit: 'percent',
            quote,
            confidence: 0.9,
          },
        ],
      },
    });

    it('should canonicalize an aliased entity name so it groups with the same entity extracted under its canonical spelling', async () => {
      // Reproduces the exact bug this feature exists to fix: two facts about the same property,
      // one naming it by a registered alias and one by its canonical name, must resolve to one
      // `factKey.entity` — otherwise they never share a `groupKeyNormalized` and their
      // disagreement is invisible to conflict detection.
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('%PDF-1.4 fixture bytes'),
        contentType: PDF_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser([buildProseElement()]));
      const aliasChunk = {
        id: 'chunk-kestrel-alias',
        text: 'The cap rate for Kestrel Point Logistics Ctr was 5.25%.',
        quote: 'was 5.25%',
        rawEntity: 'Kestrel Point Logistics Ctr',
        amount: 5.25,
      };
      const canonicalChunk = {
        id: 'chunk-kestrel-canonical',
        text: 'Kestrel Point Logistics Center reported a cap rate of 6.10%.',
        quote: 'cap rate of 6.10%',
        rawEntity: 'Kestrel Point Logistics Center',
        amount: 6.1,
      };
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        { _id: aliasChunk.id, text: aliasChunk.text, locator: { kind: 'pdf-page', page: 1 } },
        {
          _id: canonicalChunk.id,
          text: canonicalChunk.text,
          locator: { kind: 'pdf-page', page: 2 },
        },
      ]);
      for (let pass = 0; pass < 3; pass++) {
        fakeModelProvider.enqueueResult(
          buildProseOutput(aliasChunk.rawEntity, aliasChunk.amount, aliasChunk.quote),
        );
      }
      for (let pass = 0; pass < 3; pass++) {
        fakeModelProvider.enqueueResult(
          buildProseOutput(canonicalChunk.rawEntity, canonicalChunk.amount, canonicalChunk.quote),
        );
      }
      const canonicalName = 'Kestrel Point Logistics Center';
      mockCanonicalEntityService.resolveMany.mockImplementationOnce((rawNames: readonly string[]) =>
        Promise.resolve(rawNames.map(() => ({ name: canonicalName, matched: true }))),
      );
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);

      await service.extractFacts(versionId.toString(), 'default');

      // One batched call for both candidates, not one lookup per fact.
      expect(mockCanonicalEntityService.resolveMany).toHaveBeenCalledTimes(1);
      expect(mockCanonicalEntityService.resolveMany).toHaveBeenCalledWith(
        [aliasChunk.rawEntity, canonicalChunk.rawEntity],
        'default',
      );
      const insertManyMock = mockExtractedFactModel.insertMany as jest.Mock<
        Promise<unknown[]>,
        [
          {
            factKey: { entity: string };
            groupKeyNormalized: string;
            chunkId: string;
            entityMatched: boolean;
          }[],
        ]
      >;
      const insertedFacts = insertManyMock.mock.calls[0][0];
      expect(insertedFacts).toHaveLength(2);
      const byChunkId = new Map(insertedFacts.map((fact) => [fact.chunkId, fact]));
      const aliasFact = byChunkId.get(aliasChunk.id);
      const canonicalFact = byChunkId.get(canonicalChunk.id);
      expect(aliasFact?.factKey.entity).toBe(canonicalName);
      expect(canonicalFact?.factKey.entity).toBe(canonicalName);
      expect(aliasFact?.entityMatched).toBe(true);
      expect(canonicalFact?.entityMatched).toBe(true);
      // The actual proof: both facts now share one conflict-detection group.
      expect(aliasFact?.groupKeyNormalized).toBe(canonicalFact?.groupKeyNormalized);
    });

    it('should keep an unregistered entity name unchanged and mark entityMatched: false', async () => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('workbook-bytes'),
        contentType: XLSX_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser(xlsxElements));
      const chunkId = 'chunk-xlsx-region-unmatched';
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        { _id: chunkId, locator: { kind: 'xlsx-region', sheetName: SHEET_NAME, range: 'A1:C10' } },
      ]);
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);
      // `beforeEach` already arms `resolveMany` to return `matched: false` for every name — this
      // test asserts that default explicitly rather than relying on it silently.

      await service.extractFacts(versionId.toString(), 'default');

      expect(mockCanonicalEntityService.resolveMany).toHaveBeenCalledWith(
        ['Northgate Business Park'],
        'default',
      );
      const insertManyMock = mockExtractedFactModel.insertMany as jest.Mock<
        Promise<unknown[]>,
        [{ factKey: { entity: string }; entityMatched: boolean }[]]
      >;
      const insertedFacts = insertManyMock.mock.calls[0][0];
      expect(insertedFacts).toHaveLength(1);
      expect(insertedFacts[0].factKey.entity).toBe('Northgate Business Park');
      expect(insertedFacts[0].entityMatched).toBe(false);
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

  describe('findFactsForChunks', () => {
    it('should return an empty array without querying the model when chunkIds is empty', async () => {
      const result = await service.findFactsForChunks([], 'acme-corp');

      expect(result).toEqual([]);
      expect(mockExtractedFactModel.find).not.toHaveBeenCalled();
    });

    it('should query every given chunk id verbatim, scoped to tenant, with no locator-kind filter', async () => {
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      const result = await service.findFactsForChunks(['chunk-a', 'chunk-b'], 'acme-corp');

      expect(mockExtractedFactModel.find).toHaveBeenCalledWith({
        chunkId: { $in: ['chunk-a', 'chunk-b'] },
        tenantId: 'acme-corp',
      });
      expect(result).toEqual([]);
    });

    it('should return facts of any locator kind scoped to the given chunks and tenant', async () => {
      const chunkId = 'chunk-prose-1';
      const facts = [
        {
          _id: new Types.ObjectId(),
          chunkId,
          factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
          value: { amount: 6.1, unit: 'percent' },
          locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
        },
      ];
      mockExtractedFactModel.find.mockResolvedValueOnce(facts);

      const result = await service.findFactsForChunks([chunkId], 'acme-corp');

      expect(result).toEqual(facts);
    });
  });

  it('should roll back and rethrow when the fact insert fails partway', async () => {
    const stored = await fakeDocumentStore.put({
      content: Buffer.from('workbook-bytes'),
      contentType: XLSX_MIME,
      metadata: {},
    });
    mockDocumentVersionModel.findOne.mockResolvedValueOnce(buildVersion({ storageKey: stored.id }));
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

    await expect(service.extractFacts(versionId.toString(), 'default')).rejects.toBe(writeFailure);

    expect(mockExtractedFactModel.deleteMany).toHaveBeenCalledWith({
      documentVersionId: versionId,
      tenantId: 'default',
    });
  });
});
