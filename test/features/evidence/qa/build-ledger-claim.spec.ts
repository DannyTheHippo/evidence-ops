import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { CanonicalEntityListing } from '../../../../src/features/evidence/facts/canonical-entity.service';
import {
  buildLedgerClaim,
  type LedgerClaimFact,
  type LedgerClaimInput,
} from '../../../../src/features/evidence/qa/build-ledger-claim';
import type { RetrievedChunk } from '../../../../src/features/evidence/qa/types/retrieved-chunk.type';
import type { VerifierMeasure } from '../../../../src/features/evidence/qa/types/verifier-measure.type';
import {
  verifyClaim,
  type GroundingCellFact,
} from '../../../../src/features/evidence/qa/verify-claim';

const SHA256_A = 'a'.repeat(64);

const NORTHGATE: CanonicalEntityListing = {
  canonicalName: 'Northgate Business Park',
  canonicalNameNormalized: 'northgate business park',
  aliasesNormalized: [],
};

const CAP_RATE_MEASURE: VerifierMeasure = {
  slug: 'cap_rate',
  label: 'Cap Rate',
  aliases: ['cap rate'],
  valueType: 'percentage',
  canonicalUnit: 'ratio',
  units: [
    { id: 'ratio', toCanonicalFactor: 1 },
    { id: 'percent', toCanonicalFactor: 0.01 },
  ],
  toleranceKind: 'absolute',
  tolerance: 0.0025,
};

const XLSX_CELL_LOCATOR: EvidenceLocator = {
  kind: 'xlsx-cell',
  extractorVersion: 'v1',
  sheetName: 'Comps',
  cell: 'B2',
};
const XLSX_REGION_LOCATOR: EvidenceLocator = {
  kind: 'xlsx-region',
  extractorVersion: 'v1',
  sheetName: 'Comps',
  range: 'A1:B3',
};
const TEXT_BLOCK_LOCATOR: EvidenceLocator = {
  kind: 'text-block',
  extractorVersion: 'v1',
  blockIndex: 0,
  headingPath: [],
};

interface LocatorCase {
  readonly name: string;
  readonly chunkId: string;
  readonly chunkText: string;
  readonly chunkLocator: EvidenceLocator;
  readonly fact: LedgerClaimFact;
  readonly cellFacts: readonly GroundingCellFact[];
}

// The real xlsx parser's own row-window markdown (`chunker.ts`'s `toMarkdownRow`/
// `toMarkdownSeparatorRow`) over a two-row sheet.
const XLSX_CHUNK_TEXT = [
  '| Property | Cap Rate |',
  '| --- | --- |',
  '| Northgate Business Park | 6.25% |',
  '| Sablewood Retail Court | 5.10% |',
].join('\n');

const XLSX_CELL_CASE: LocatorCase = {
  name: 'xlsx-cell',
  chunkId: 'chunk-xlsx-cap-rate',
  chunkText: XLSX_CHUNK_TEXT,
  chunkLocator: XLSX_REGION_LOCATOR,
  fact: {
    factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: 'unstated' },
    value: { amount: 6.25, unit: 'percent' },
    rawText: '6.25%',
    chunkId: 'chunk-xlsx-cap-rate',
    documentVersionId: 'version-xlsx',
    locator: XLSX_CELL_LOCATOR,
  },
  cellFacts: [
    {
      chunkId: 'chunk-xlsx-cap-rate',
      factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: 'unstated' },
      value: { amount: 6.25, unit: 'percent' },
      locator: XLSX_CELL_LOCATOR,
    },
  ],
};

const TEXT_BLOCK_CHUNK_TEXT =
  'Northgate Business Park was acquired in early 2025. The cap rate was 6.25% at closing. ' +
  'Comparable properties in the submarket traded similarly.';

const TEXT_BLOCK_CASE: LocatorCase = {
  name: 'text-block',
  chunkId: 'chunk-text-block-cap-rate',
  chunkText: TEXT_BLOCK_CHUNK_TEXT,
  chunkLocator: TEXT_BLOCK_LOCATOR,
  fact: {
    factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-Q1' },
    value: { amount: 6.25, unit: 'percent' },
    rawText: 'The cap rate was 6.25% at closing.',
    chunkId: 'chunk-text-block-cap-rate',
    documentVersionId: 'version-text-block',
    locator: TEXT_BLOCK_LOCATOR,
  },
  // A prose fact carries no cell-level extraction of its own — `verify-claim.ts` only falls back
  // to raw-chunk-text numeric matching once a cited chunk has zero cell facts.
  cellFacts: [],
};

function buildInput(
  locatorCase: LocatorCase,
  overrides: Partial<LedgerClaimInput> = {},
): LedgerClaimInput {
  return {
    fact: locatorCase.fact,
    chunkText: locatorCase.chunkText,
    sha256: SHA256_A,
    entityLabel: 'Northgate Business Park',
    measureLabel: 'cap_rate',
    ...overrides,
  };
}

function buildRetrievedChunk(locatorCase: LocatorCase): RetrievedChunk {
  return {
    chunkId: locatorCase.chunkId,
    docVersionId: locatorCase.fact.documentVersionId,
    sha256: SHA256_A,
    text: locatorCase.chunkText,
    locator: locatorCase.chunkLocator,
  };
}

describe('buildLedgerClaim', () => {
  it.each([XLSX_CELL_CASE, TEXT_BLOCK_CASE])(
    'should build a claim that survives verifyClaim, with and without measures, for a $name fact',
    (locatorCase) => {
      const claim = buildLedgerClaim(buildInput(locatorCase));

      expect(claim).not.toBeNull();
      if (!claim) throw new Error('unreachable');

      const chunk = buildRetrievedChunk(locatorCase);

      const legacyResult = verifyClaim({
        claim,
        retrievedChunks: [chunk],
        cellFacts: locatorCase.cellFacts,
      });
      expect(legacyResult.kind).toBe('survived');

      const structuredResult = verifyClaim({
        claim,
        retrievedChunks: [chunk],
        cellFacts: locatorCase.cellFacts,
        measures: [CAP_RATE_MEASURE],
        entities: [NORTHGATE],
      });
      expect(structuredResult.kind).toBe('survived');
    },
  );

  it('should return null when a measure label carries a digit — a second, unexplained numeric token in the statement', () => {
    const claim = buildLedgerClaim(buildInput(XLSX_CELL_CASE, { measureLabel: 'cap_rate_v2' }));

    expect(claim).toBeNull();
  });

  it('should return null when the fact carries no quote locatable in the chunk at all', () => {
    const unrelatedChunkText = ['| Other | Value |', '| --- | --- |', '| Item | 9.99% |'].join(
      '\n',
    );

    const claim = buildLedgerClaim(buildInput(XLSX_CELL_CASE, { chunkText: unrelatedChunkText }));

    expect(claim).toBeNull();
  });

  it('should return null when the only candidate quote shares no content with the statement', () => {
    const fact: LedgerClaimFact = {
      factKey: { entity: 'Cedar Bluff Logistics Center', metric: 'cap_rate', period: 'unstated' },
      value: { amount: 6.25, unit: 'percent' },
      rawText: '6.25 percent',
      chunkId: 'chunk-unrelated-prose',
      documentVersionId: 'version-unrelated',
      locator: TEXT_BLOCK_LOCATOR,
    };

    const claim = buildLedgerClaim({
      fact,
      chunkText: 'Vacancy fell to 6.25 percent across the portfolio this quarter.',
      sha256: SHA256_A,
      entityLabel: 'Cedar Bluff Logistics Center',
      measureLabel: 'cap_rate',
    });

    expect(claim).toBeNull();
  });
});
