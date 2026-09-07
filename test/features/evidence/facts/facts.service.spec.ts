import { InternalServerErrorException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { environmentSchema } from '../../../../src/config/environment/environment.config';
import { TypedConfigService } from '../../../../src/config/environment/typed-config.service';
import { DocumentVersion } from '../../../../src/database/schemas/evidence/document-version/document-version.schema';
import { EvidenceChunk } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { ExtractedFact } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { CanonicalEntityResolution } from '../../../../src/features/evidence/facts/canonical-entity.service';
import { CanonicalEntityService } from '../../../../src/features/evidence/facts/canonical-entity.service';
import { DocumentVersionNotFoundException } from '../../../../src/features/evidence/facts/exceptions/facts.exception';
import { FactsService } from '../../../../src/features/evidence/facts/facts.service';
import type { HarvestedAliasSubject } from '../../../../src/features/evidence/facts/harvest-parenthetical-aliases';
import {
  ACTIVE_PACK_ID,
  ACTIVE_PACK_VERSION,
} from '../../../../src/features/evidence/facts/metric-ontology';
import { PASS_COUNT } from '../../../../src/features/evidence/facts/prose-fact-extractor';
import { ParserRegistry } from '../../../../src/features/evidence/ingestion/parser.registry';
import type {
  DocumentParser,
  ParsedElement,
} from '../../../../src/features/evidence/ingestion/parsers/parsed-element.type';
import { EVIDENCE_DELIMITER_TAG } from '../../../../src/features/evidence/ingestion/sanitize-evidence-text';
import {
  orderForExtraction,
  toMeasureDefinitions,
  type MeasureDefinition,
  type MeasureStamp,
} from '../../../../src/features/evidence/measures/measure-definition';
import { buildSeedMeasureRows } from '../../../../src/features/evidence/measures/measure-seed';
import type { ExtractionMeasureContext } from '../../../../src/features/evidence/measures/measures.service';
import { MeasuresService } from '../../../../src/features/evidence/measures/measures.service';
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
 * Extraction config exactly as a deployment that sets none of these variables gets it — parsed out
 * of the real schema rather than restated as a literal, so a test asserting the shipped default
 * asserts what ships. A hand-written `false` here would pin nothing: the test would supply the
 * value it then checked.
 */
const SHIPPED_EXTRACTION_CONFIG = environmentSchema.parse({ NODE_ENV: 'test' }).extraction;

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
    recordHarvestedAliases: jest.fn(),
  } satisfies Record<
    keyof Pick<CanonicalEntityService, 'resolveMany' | 'recordHarvestedAliases'>,
    jest.Mock
  >;
  // Armed in `beforeEach` to the tenant's seed measures (`buildDefaultContext`) so every existing
  // test's `cap_rate` candidate resolves to a real stamp without arranging the registry itself;
  // tests about the registry's own branches (no stamp, a header proposal) override per-call.
  const mockMeasuresService = {
    loadExtractionContext: jest.fn(),
    proposeMany: jest.fn(),
  } satisfies Record<
    keyof Pick<MeasuresService, 'loadExtractionContext' | 'proposeMany'>,
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

  /**
   * The tenant's seed measures, projected the same way `MeasuresService.loadExtractionContext`
   * projects them — `toMeasureDefinitions(orderForExtraction(...))` over `buildSeedMeasureRows`,
   * each row given a fresh `_id` the way `measure-definition.spec.ts`'s own replay-cache pin does.
   * Every existing test's `cap_rate` candidate resolves against this by slug.
   */
  const buildMeasureDefinitions = (tenantId = 'default'): MeasureDefinition[] =>
    orderForExtraction(
      toMeasureDefinitions(
        buildSeedMeasureRows(tenantId).map((row) => ({ ...row, _id: new Types.ObjectId() })),
      ),
    );

  const buildDefaultContext = (tenantId = 'default'): ExtractionMeasureContext => {
    const confirmed = buildMeasureDefinitions(tenantId);
    return { confirmed, matchable: confirmed, rejectedSlugs: new Set() };
  };

  const buildService = async (
    options: {
      chunkConcurrency?: number;
      aliasHarvestAutoApply?: boolean;
      headerProposals?: boolean;
      modelProvider?: ModelProvider;
    } = {},
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
        {
          provide: TypedConfigService,
          useValue: getMockTypedConfig({
            extraction: {
              ...SHIPPED_EXTRACTION_CONFIG,
              chunkConcurrency:
                options.chunkConcurrency ?? SHIPPED_EXTRACTION_CONFIG.chunkConcurrency,
              aliasHarvestAutoApply:
                options.aliasHarvestAutoApply ?? SHIPPED_EXTRACTION_CONFIG.aliasHarvestAutoApply,
              headerProposals: options.headerProposals ?? SHIPPED_EXTRACTION_CONFIG.headerProposals,
            },
          }),
        },
        { provide: AppLogger, useValue: mockLogger },
        { provide: MeasuresService, useValue: mockMeasuresService },
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
    mockCanonicalEntityService.recordHarvestedAliases.mockResolvedValue(0);
    mockCanonicalEntityService.resolveMany.mockImplementation((rawNames: readonly string[]) =>
      Promise.resolve(
        rawNames.map((name): CanonicalEntityResolution => ({ name, matched: false })),
      ),
    );
    mockMeasuresService.loadExtractionContext.mockResolvedValue(buildDefaultContext());
    mockMeasuresService.proposeMany.mockResolvedValue(new Map<string, MeasureStamp>());

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

    /**
     * `periodStart`/`periodEnd` are derived at extraction from the period key, not stored by the
     * extractor — and only when that key names a real span. A sheet with a date column produces
     * one; the `undated` key every other fixture here uses produces neither, which is why this
     * needs its own row rather than an assertion bolted onto an existing test.
     */
    it('should stamp period bounds when the row states a datable period', async () => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('workbook-bytes'),
        contentType: XLSX_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(
        buildStubParser([
          buildXlsxElement('A1', 'Property Name'),
          buildXlsxElement('B1', 'Cap Rate'),
          buildXlsxElement('C1', 'Sale Date'),
          buildXlsxElement('A2', 'Northgate Business Park'),
          buildXlsxElement('B2', '5.25%'),
          buildXlsxElement('C2', '2025-03-14'),
        ]),
      );
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        {
          _id: new Types.ObjectId(),
          locator: { kind: 'xlsx-region', sheetName: SHEET_NAME, range: 'A1:C10' },
        },
      ]);
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);

      await service.extractFacts(versionId.toString(), 'default');

      const [rows] = mockExtractedFactModel.insertMany.mock.calls[0] as [Record<string, unknown>[]];
      expect(rows).toHaveLength(1);
      expect((rows[0].factKey as { period: string }).period).toBe('2025-03');
      expect(rows[0].periodStart).toEqual(new Date('2025-03-01T00:00:00.000Z'));
      expect(rows[0].periodEnd).toEqual(new Date('2025-03-31T00:00:00.000Z'));
    });

    /**
     * The fail-closed half of the measure stamp. A slug the tenant has rejected mints no stamp,
     * and a candidate with no stamp is dropped rather than persisted: a fact stamped to nothing
     * would be invisible to every consumer that filters on `measureStatus` while still occupying
     * the ledger — worse than never extracting it, because nothing would ever surface it again.
     */
    it('should drop a candidate whose measure the tenant has rejected, and persist nothing', async () => {
      const definitions = buildMeasureDefinitions();
      const rejected = definitions.map((definition) =>
        definition.id === 'cap_rate' ? { ...definition, status: 'rejected' as const } : definition,
      );
      mockMeasuresService.loadExtractionContext.mockResolvedValueOnce({
        confirmed: rejected,
        matchable: rejected,
        rejectedSlugs: new Set(['cap_rate']),
      });
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
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        {
          _id: new Types.ObjectId(),
          locator: { kind: 'xlsx-region', sheetName: SHEET_NAME, range: 'A1:C10' },
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
      // Dropped visibly: a silent drop here would look identical to a document that simply held
      // no facts.
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('cap_rate'));
    });

    /**
     * The header-proposal path end to end: an unmatched numeric column is filed with the registry,
     * and the stamp `proposeMany` returns is what the resulting facts carry. The facts land
     * `proposed`, which is precisely why every ledger and conflict consumer filters on
     * `measureStatus` — they exist, and they do not count, until an admin confirms the measure.
     */
    it('should stamp facts from a header proposal with the stamp the registry returned', async () => {
      const service = await buildService({ headerProposals: true });
      const proposedMeasureId = new Types.ObjectId();
      mockMeasuresService.proposeMany.mockResolvedValueOnce(
        new Map<string, MeasureStamp>([
          [
            'unit_count',
            {
              measureId: proposedMeasureId,
              measureVersion: 1,
              measureStatus: 'proposed',
            },
          ],
        ]),
      );
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('workbook-bytes'),
        contentType: XLSX_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(
        buildStubParser([
          buildXlsxElement('A1', 'Property Name'),
          buildXlsxElement('B1', 'Unit Count'),
          buildXlsxElement('A2', 'Northgate Business Park'),
          buildXlsxElement('B2', '48'),
        ]),
      );
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        {
          _id: new Types.ObjectId(),
          locator: { kind: 'xlsx-region', sheetName: SHEET_NAME, range: 'A1:C10' },
        },
      ]);
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);

      await service.extractFacts(versionId.toString(), 'default');

      expect(mockMeasuresService.proposeMany).toHaveBeenCalledWith(
        'default',
        versionId,
        expect.arrayContaining([expect.objectContaining({ slug: 'unit_count' })]),
      );
      const [rows] = mockExtractedFactModel.insertMany.mock.calls[0] as [Record<string, unknown>[]];
      const proposedRow = rows.find(
        (row) => (row.factKey as { metric: string }).metric === 'unit_count',
      );
      expect(proposedRow).toBeDefined();
      expect(proposedRow?.measureStatus).toBe('proposed');
      expect(proposedRow?.measureVersion).toBe(1);
      expect((proposedRow?.measureId as Types.ObjectId).toString()).toBe(
        proposedMeasureId.toString(),
      );
    });

    it('should append the ambiguous-header fidelity reason onto the version, even when the ambiguity leaves no facts to extract', async () => {
      // Row 1 qualifies as a header (>= 2 non-empty cells, >= 2 distinct values, an occupied row
      // after it) but repeats each value across two columns — the two-row-header shape
      // `resolveHeaderRow` (sheet-header.ts) can only flag, not resolve on its own. Row 2 (the
      // real column labels) is then read as data, so this sheet also produces zero facts — proving
      // the reason reaches the version even on the empty-candidates branch.
      const twoRowHeaderElements: ParsedElement[] = [
        buildXlsxElement('A1', 'Sale'),
        buildXlsxElement('B1', 'Sale'),
        buildXlsxElement('C1', 'Metrics'),
        buildXlsxElement('D1', 'Metrics'),
        buildXlsxElement('A2', 'Property Name'),
        buildXlsxElement('B2', 'Sale Date'),
        buildXlsxElement('C2', 'Cap Rate'),
        buildXlsxElement('D2', 'Occupancy'),
        buildXlsxElement('A3', 'Northgate Business Park'),
        buildXlsxElement('B3', '2025-01-01'),
        buildXlsxElement('C3', '5.25%'),
        buildXlsxElement('D3', '92%'),
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
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser(twoRowHeaderElements));
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        {
          _id: 'chunk-two-row-header',
          locator: { kind: 'xlsx-region', sheetName: SHEET_NAME, range: 'A1:D10' },
        },
      ]);

      const result = await service.extractFacts(versionId.toString(), 'default');

      expect(result).toEqual({
        factsCreated: 0,
        alreadyExtracted: false,
        skippedChunkCount: 0,
        factKeys: [],
      });
      expect(mockDocumentVersionModel.updateOne).toHaveBeenCalledWith(
        { _id: versionId, tenantId: 'default' },
        {
          $addToSet: {
            reducedFidelityReasons: {
              $each: [
                expect.stringContaining(
                  `Sheet '${SHEET_NAME}': row 1 qualifies as the header but repeats a value`,
                ),
              ],
            },
          },
        },
      );
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
      // Names the entity as well as the value: the extractor takes `factKey.entity` from a span of
      // this text, so a chunk that never names the property produces no facts at all.
      const chunkText = 'For Northgate Business Park the cap rate is 5.25% per the offering memo.';
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        { _id: chunkId, text: chunkText, locator: { kind: 'pdf-page', page: 1 } },
      ]);
      const modelOutput = {
        output: {
          facts: [
            {
              entityQuote: 'Northgate Business Park',
              metric: 'cap_rate',
              periodText: '',
              observedAtText: '',
              amount: 5.25,
              unit: 'percent',
              quote: 'cap rate is 5.25%',
              confidence: 0.9,
            },
            {
              entityQuote: 'Northgate Business Park',
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
      // Names the entity as well as the value: the extractor takes `factKey.entity` from a span of
      // this text, so a chunk that never names the property produces no facts at all.
      const chunkText = 'For Northgate Business Park the cap rate is 5.25% per the offering memo.';
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
              entityQuote: 'Northgate Business Park',
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
      // The chunk-level skip already says every group is gone; repeating each of them as a
      // dropped group would add noise, not information.
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('dropped fact group'),
      );
    });

    it('should report a group no two passes agreed on, rather than losing it silently', async () => {
      // The dominant prose loss path made visible: three passes propose the same
      // `(entity, metric, period)` with values further apart than the metric's tolerance, so no
      // two of them cluster, the group drops, and the only trace it ever existed is this warn.
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
      const chunkId = 'chunk-prose-disagreement';
      const chunkText = 'For Northgate Business Park the cap rate is 5.25% per the offering memo.';
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        { _id: chunkId, text: chunkText, locator: { kind: 'pdf-page', page: 1 } },
      ]);
      // 25bp tolerance on cap_rate: 5.25 / 7.4 / 9.9 percent are pairwise far outside it.
      for (const amount of [5.25, 7.4, 9.9]) {
        fakeModelProvider.enqueueResult({
          output: {
            facts: [
              {
                entityQuote: 'Northgate Business Park',
                metric: 'cap_rate',
                periodText: '',
                observedAtText: '',
                amount,
                unit: 'percent',
                quote: 'cap rate is 5.25%',
                confidence: 0.9,
              },
            ],
          },
        });
      }

      const result = await service.extractFacts(versionId.toString(), 'default');

      expect(result).toEqual({
        factsCreated: 0,
        alreadyExtracted: false,
        // Not a skipped chunk: all 3 passes succeeded, they simply did not agree.
        skippedChunkCount: 0,
        factKeys: [],
      });
      expect(mockExtractedFactModel.insertMany).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        `Chunk '${chunkId}' dropped fact group 'northgate business park::cap_rate::undated': 1 of 3 passes agreed`,
      );
    });

    /**
     * Chunk texts and the unanimous 3-pass model output for each, for the two multi-chunk tests
     * below. Both chunks carry the same metric and differ by entity so neither can be mistaken
     * for the other's candidate, and each chunk states both its own quote and its own entity
     * verbatim — grounding is what decides whether a candidate survives, and it covers the entity
     * span as well as the value's quote.
     */
    const CHUNK_A = {
      id: 'chunk-prose-a',
      text: 'For Northgate Business Park the cap rate is 5.25% per the offering memo.',
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
            entityQuote: chunk.entity,
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
            entityQuote: entity,
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
      mockCanonicalEntityService.resolveMany.mockImplementation((rawNames: readonly string[]) =>
        Promise.resolve(rawNames.map(() => ({ name: canonicalName, matched: true }))),
      );
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);

      await service.extractFacts(versionId.toString(), 'default');

      // One batched call per chunk — resolution runs inside the chunk's extraction, ahead of the
      // agreement between its passes, so it cannot be deferred to a single end-of-document lookup.
      // Each call carries every pass's candidate at once, not one lookup per pass.
      expect(mockCanonicalEntityService.resolveMany).toHaveBeenCalledTimes(2);
      expect(mockCanonicalEntityService.resolveMany).toHaveBeenCalledWith(
        Array.from({ length: PASS_COUNT }, () => aliasChunk.rawEntity),
        'default',
      );
      expect(mockCanonicalEntityService.resolveMany).toHaveBeenCalledWith(
        Array.from({ length: PASS_COUNT }, () => canonicalChunk.rawEntity),
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
        measureStatus: 'confirmed',
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
        measureStatus: 'confirmed',
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

  /**
   * The exclusion invariant: a fact extracted under a measure no admin has confirmed yet is stored
   * but must not reach a conflict scan or a ledger answer, so both citation-facing lookups filter
   * on `measureStatus: 'confirmed'` — parameterised over the method rather than asserted once, so
   * the property is pinned independently of which method the plan happens to name first.
   */
  it.each<['findCellFacts' | 'findFactsForChunks']>([['findCellFacts'], ['findFactsForChunks']])(
    "%s excludes a proposed measure's facts from its query filter",
    async (method) => {
      mockExtractedFactModel.find.mockResolvedValueOnce([]);

      await service[method](['chunk-a'], 'acme-corp');

      expect(mockExtractedFactModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ measureStatus: 'confirmed' }),
      );
    },
  );

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

  describe('harvesting in-document alias definitions', () => {
    // A cell whose text states a parenthetical definition. Sits below the fixture's data row, so
    // it adds a definition to harvest without adding a fact to extract.
    const definitionElements: ParsedElement[] = [
      ...xlsxElements,
      buildXlsxElement('A4', 'The asset is Northgate Business Park (the "Property").'),
    ];

    const arrangeXlsxVersion = async (elements: ParsedElement[] = definitionElements) => {
      const stored = await fakeDocumentStore.put({
        content: Buffer.from('workbook-bytes'),
        contentType: XLSX_MIME,
        metadata: {},
      });
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(
        buildVersion({ storageKey: stored.id }),
      );
      mockExtractedFactModel.find.mockResolvedValueOnce([]);
      mockParserRegistry.resolve.mockReturnValueOnce(buildStubParser(elements));
      mockEvidenceChunkModel.find.mockResolvedValueOnce([
        {
          _id: 'chunk-xlsx-region-1',
          locator: { kind: 'xlsx-region', sheetName: SHEET_NAME, range: 'A1:C10' },
        },
      ]);
      mockExtractedFactModel.insertMany.mockResolvedValueOnce([]);
    };

    /**
     * The two-step enable, pinned. `SHIPPED_EXTRACTION_CONFIG` is parsed from the real environment
     * schema, so this asserts the default a deployment actually gets rather than a value the test
     * supplies: flipping `EXTRACTION_ALIAS_HARVEST_AUTO_APPLY`'s default turns it red. What it
     * pins is inertness — with the flag off, an alias is recorded as a proposal, and
     * `CanonicalEntity`'s pre-validate hook folds only `applied` entries into `aliasesNormalized`,
     * so nothing this call writes changes what resolves.
     */
    it('should record a document-stated alias as a proposal under the shipped configuration', async () => {
      await arrangeXlsxVersion();

      await service.extractFacts(versionId.toString(), 'default');

      expect(mockCanonicalEntityService.recordHarvestedAliases).toHaveBeenCalledWith(
        [
          {
            // Recast rather than bare `expect.arrayContaining(...)` inside the object literal —
            // its `any`-typed return trips `no-unsafe-assignment` wherever it lands in one.
            subjectCandidates: expect.arrayContaining([
              {
                name: 'Northgate Business Park',
                quote: 'Northgate Business Park (the "Property")',
              },
            ]) as HarvestedAliasSubject[],
            aliases: ['Property', 'the Property'],
            locator: definitionElements[4].locator,
          },
        ],
        'default',
        versionId,
        false,
      );
    });

    it('should harvest without a model call', async () => {
      await arrangeXlsxVersion();

      await service.extractFacts(versionId.toString(), 'default');

      expect(mockCanonicalEntityService.recordHarvestedAliases).toHaveBeenCalledTimes(1);
      expect(fakeModelProvider.calls).toEqual([]);
    });

    it('should apply harvested aliases once an operator enables auto-application', async () => {
      service = await buildService({ aliasHarvestAutoApply: true });
      await arrangeXlsxVersion();

      await service.extractFacts(versionId.toString(), 'default');

      expect(mockCanonicalEntityService.recordHarvestedAliases).toHaveBeenCalledWith(
        expect.anything(),
        'default',
        versionId,
        true,
      );
    });

    // Fails OPEN: harvesting enriches the registry, extraction is the work it runs inside.
    it('should extract facts anyway when the registry write fails', async () => {
      mockCanonicalEntityService.recordHarvestedAliases.mockRejectedValueOnce(
        new Error('write concern failed'),
      );
      await arrangeXlsxVersion();

      const result = await service.extractFacts(versionId.toString(), 'default');

      expect(result.factsCreated).toBe(1);
      expect(mockExtractedFactModel.insertMany).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Alias harvesting failed'),
      );
    });

    it('should not harvest again for a version that was already extracted', async () => {
      mockDocumentVersionModel.findOne.mockResolvedValueOnce(buildVersion());
      mockExtractedFactModel.find.mockResolvedValueOnce([
        { factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: 'undated' } },
      ]);

      await service.extractFacts(versionId.toString(), 'default');

      expect(mockCanonicalEntityService.recordHarvestedAliases).not.toHaveBeenCalled();
    });
  });
});
