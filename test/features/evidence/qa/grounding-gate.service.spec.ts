import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { normalizeEntityName } from '../../../../src/database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { EvidenceLocator } from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { FactKey } from '../../../../src/database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { groupKey } from '../../../../src/features/evidence/conflicts/detect-conflicts';
import type {
  AnsweredOutcome,
  Citation,
  Claim,
} from '../../../../src/features/evidence/qa/contracts/answer.contract';
import {
  factKeysMatch,
  GroundingGateService,
} from '../../../../src/features/evidence/qa/grounding-gate.service';
import type { RetrievedChunk } from '../../../../src/features/evidence/qa/types/retrieved-chunk.type';
import type { GroundingCellFact } from '../../../../src/features/evidence/qa/verify-claim';
import { groundingClaimsDroppedCounter } from '../../../../src/providers/telemetry/domain-metrics';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';

const SHA256_A = 'a'.repeat(64);
const PDF_LOCATOR: EvidenceLocator = { kind: 'pdf-page', extractorVersion: 'v1', page: 2 };

const CHUNK: RetrievedChunk = {
  chunkId: 'chunk-1',
  docVersionId: 'doc-v1',
  sha256: SHA256_A,
  text: 'Northgate Business Park traded in March 2025 at a cap rate of approximately 6.10%.',
  locator: PDF_LOCATOR,
};

const OTHER_CHUNK: RetrievedChunk = {
  chunkId: 'chunk-2',
  docVersionId: 'doc-v1',
  sha256: SHA256_A,
  text: 'Sablewood Retail Court traded in April 2025 at a cap rate of approximately 5.90%.',
  locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 5 },
};

function buildCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    docVersionId: 'doc-v1',
    sha256: SHA256_A,
    chunkId: CHUNK.chunkId,
    locator: PDF_LOCATOR,
    quote: 'at a cap rate of approximately 6.10%',
    ...overrides,
  };
}

function buildClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    statement: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
    citations: [buildCitation()],
    ...overrides,
  };
}

function buildOutcome(claims: Claim[]): AnsweredOutcome {
  return { kind: 'answered', claims };
}

describe('GroundingGateService', () => {
  let service: GroundingGateService;
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GroundingGateService, { provide: AppLogger, useValue: mockLogger }],
    }).compile();

    service = module.get<GroundingGateService>(GroundingGateService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should return "answered" with full coverage when every claim survives', () => {
    const outcome = buildOutcome([buildClaim()]);

    const report = service.verify({ outcome, retrievedChunks: [CHUNK] });

    expect(report.outcomeKind).toBe('answered');
    expect(report.claims).toHaveLength(1);
    expect(report.droppedClaims).toEqual([]);
    expect(report.claimCoverage).toBe(1);
  });

  it('should default cellFacts and conflictedFactKeys to empty when omitted', () => {
    const outcome = buildOutcome([buildClaim()]);

    const report = service.verify({ outcome, retrievedChunks: [CHUNK] });

    expect(report.outcomeKind).toBe('answered');
  });

  it('should return "answered" with reduced coverage when some claims are dropped, and log each drop', () => {
    const droppedCounterSpy = jest.spyOn(groundingClaimsDroppedCounter, 'add');
    const survivingClaim = buildClaim();
    const droppedClaim = buildClaim({
      statement: 'Sablewood Retail Court traded at a cap rate of approximately 5.90%.',
      citations: [buildCitation({ chunkId: 'chunk-fabricated' })],
    });
    const outcome = buildOutcome([survivingClaim, droppedClaim]);

    const report = service.verify({ outcome, retrievedChunks: [CHUNK] });

    expect(report.outcomeKind).toBe('answered');
    expect(report.claims).toHaveLength(1);
    expect(report.droppedClaims).toHaveLength(1);
    expect(report.droppedClaims[0].statement).toBe(droppedClaim.statement);
    expect(report.claimCoverage).toBe(0.5);
    expect(report.violations.length).toBeGreaterThan(0);
    expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining(droppedClaim.statement));
    // `chunk-fabricated` was never retrieved, so check 1 (retrieval containment) is what drops
    // this claim — the metric attribute must name that rule, never the claim's free-text reason.
    expect(droppedCounterSpy).toHaveBeenCalledTimes(1);
    expect(droppedCounterSpy).toHaveBeenCalledWith(1, { rule: 'chunk-not-retrieved' });
  });

  it('should degrade to "insufficient_evidence" with zero coverage when every claim drops', () => {
    const droppedClaim = buildClaim({
      citations: [buildCitation({ chunkId: 'chunk-fabricated' })],
    });
    const outcome = buildOutcome([droppedClaim]);

    const report = service.verify({ outcome, retrievedChunks: [CHUNK] });

    expect(report.outcomeKind).toBe('insufficient_evidence');
    expect(report.claims).toEqual([]);
    expect(report.claimCoverage).toBe(0);
    expect(report.droppedClaims).toHaveLength(1);
  });

  it('should treat zero input claims as "insufficient_evidence" with zero coverage, never NaN', () => {
    const outcome = buildOutcome([]);

    const report = service.verify({ outcome, retrievedChunks: [CHUNK] });

    expect(report.outcomeKind).toBe('insufficient_evidence');
    expect(report.claimCoverage).toBe(0);
    expect(Number.isNaN(report.claimCoverage)).toBe(false);
  });

  it('should force "conflicting_evidence" when a surviving claim touches a conflicted fact key, even though it verified cleanly', () => {
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const cellFacts: GroundingCellFact[] = [
      {
        chunkId: CHUNK.chunkId,
        factKey,
        value: { amount: 6.1, unit: 'percent' },
        locator: PDF_LOCATOR,
      },
    ];
    const outcome = buildOutcome([buildClaim()]);

    const report = service.verify({
      outcome,
      retrievedChunks: [CHUNK],
      cellFacts,
      conflictedFactKeys: [factKey],
    });

    expect(report.outcomeKind).toBe('conflicting_evidence');
    expect(report.conflictingFactKey).toEqual(factKey);
    expect(report.claims).toHaveLength(1); // the claim itself still verified and survives
  });

  it('should match a conflicted fact key case-insensitively and trimmed on entity, exact on metric/period', () => {
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const cellFacts: GroundingCellFact[] = [
      {
        chunkId: CHUNK.chunkId,
        factKey,
        value: { amount: 6.1, unit: 'percent' },
        locator: PDF_LOCATOR,
      },
    ];
    const outcome = buildOutcome([buildClaim()]);

    const report = service.verify({
      outcome,
      retrievedChunks: [CHUNK],
      cellFacts,
      conflictedFactKeys: [
        { entity: '  northgate business park  ', metric: 'cap_rate', period: '2025-03' },
      ],
    });

    expect(report.outcomeKind).toBe('conflicting_evidence');
  });

  it('should NOT force "conflicting_evidence" when the touched fact key does not match any conflicted key', () => {
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const unrelatedConflictKey = {
      entity: 'Cedar Bluff Logistics',
      metric: 'sale_price',
      period: '2025-03',
    };
    const cellFacts: GroundingCellFact[] = [
      {
        chunkId: CHUNK.chunkId,
        factKey,
        value: { amount: 6.1, unit: 'percent' },
        locator: PDF_LOCATOR,
      },
    ];
    const outcome = buildOutcome([buildClaim()]);

    const report = service.verify({
      outcome,
      retrievedChunks: [CHUNK],
      cellFacts,
      conflictedFactKeys: [unrelatedConflictKey],
    });

    expect(report.outcomeKind).toBe('answered');
  });

  it('should NOT force "conflicting_evidence" on a claim about one property just because a conflicted fact for a different property shares its cited chunk', () => {
    // Regression for the chunk-grain over-triggering bound (ADR-0004 bound 3, narrowed): a comps
    // sheet's row-window chunk holds several properties' facts at once. A claim citing that chunk
    // about Cedar Bluff's building area must not inherit Northgate's cap-rate conflict merely
    // because both facts were extracted from the same chunk — it must "touch" (per
    // `verifyClaim`'s value-matched `touchedFactKeys`) only the fact whose value it actually
    // states. Fails against the pre-fix chunk-scoped implementation, which forced
    // `conflicting_evidence` here.
    const compsChunk: RetrievedChunk = {
      chunkId: 'chunk-comps',
      docVersionId: 'doc-v1',
      sha256: SHA256_A,
      text: 'Cedar Bluff Logistics Center reported a building area of 412,000 SF. Northgate Business Park traded at a cap rate of approximately 6.10%.',
      locator: { kind: 'xlsx-region', extractorVersion: 'v1', sheetName: 'Comps', range: 'A1:H5' },
    };
    const cedarBluffFactKey = {
      entity: 'Cedar Bluff Logistics Center',
      metric: 'building_area',
      period: '2025-03',
    };
    const northgateFactKey = {
      entity: 'Northgate Business Park',
      metric: 'cap_rate',
      period: '2025-03',
    };
    const cellFacts: GroundingCellFact[] = [
      {
        chunkId: compsChunk.chunkId,
        factKey: cedarBluffFactKey,
        value: { amount: 412_000, unit: 'sf' },
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'C2' },
      },
      {
        chunkId: compsChunk.chunkId,
        factKey: northgateFactKey,
        value: { amount: 6.1, unit: 'percent' },
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F4' },
      },
    ];
    const unrelatedClaim = buildClaim({
      statement: 'Cedar Bluff Logistics Center has a building area of 412,000 SF.',
      citations: [
        buildCitation({
          chunkId: compsChunk.chunkId,
          quote: 'Cedar Bluff Logistics Center reported a building area of 412,000 SF.',
          locator: compsChunk.locator,
        }),
      ],
    });
    const outcome = buildOutcome([unrelatedClaim]);

    const report = service.verify({
      outcome,
      retrievedChunks: [compsChunk],
      cellFacts,
      conflictedFactKeys: [northgateFactKey],
    });

    expect(report.outcomeKind).toBe('answered');

    // The seeded conflict itself — a claim that actually states Northgate's cap rate, citing the
    // same chunk — must still be forced. Narrowing the over-trigger must not weaken the gate's
    // fail-closed posture on the check that matters.
    const northgateClaim = buildClaim({
      statement: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
      citations: [
        buildCitation({
          chunkId: compsChunk.chunkId,
          quote: 'Northgate Business Park traded at a cap rate of approximately 6.10%.',
          locator: compsChunk.locator,
        }),
      ],
    });
    const conflictReport = service.verify({
      outcome: buildOutcome([northgateClaim]),
      retrievedChunks: [compsChunk],
      cellFacts,
      conflictedFactKeys: [northgateFactKey],
    });

    expect(conflictReport.outcomeKind).toBe('conflicting_evidence');
    expect(conflictReport.conflictingFactKey).toEqual(northgateFactKey);
  });

  it('should not force a conflict from a fact touched only by a dropped claim', () => {
    const factKey = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const cellFacts: GroundingCellFact[] = [
      {
        chunkId: CHUNK.chunkId,
        factKey,
        value: { amount: 6.1, unit: 'percent' },
        locator: PDF_LOCATOR,
      },
    ];
    const droppedClaim = buildClaim({
      citations: [buildCitation({ chunkId: 'chunk-fabricated' })],
    });
    const outcome = buildOutcome([droppedClaim]);

    const report = service.verify({
      outcome,
      retrievedChunks: [CHUNK],
      cellFacts,
      conflictedFactKeys: [factKey],
    });

    expect(report.outcomeKind).toBe('insufficient_evidence');
  });

  it('should stop scanning for a conflict once the first touched conflict is found (short-circuit)', () => {
    const factKeyOne = { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' };
    const factKeyTwo = { entity: 'Sablewood Retail Court', metric: 'cap_rate', period: '2025-04' };
    const cellFacts: GroundingCellFact[] = [
      {
        chunkId: CHUNK.chunkId,
        factKey: factKeyOne,
        value: { amount: 6.1, unit: 'percent' },
        locator: PDF_LOCATOR,
      },
      {
        chunkId: OTHER_CHUNK.chunkId,
        factKey: factKeyTwo,
        value: { amount: 5.9, unit: 'percent' },
        locator: OTHER_CHUNK.locator,
      },
    ];
    const claimOne = buildClaim();
    const claimTwo = buildClaim({
      statement: 'Sablewood Retail Court traded at a cap rate of approximately 5.90%.',
      citations: [
        buildCitation({
          chunkId: OTHER_CHUNK.chunkId,
          quote: 'at a cap rate of approximately 5.90%',
        }),
      ],
    });
    const outcome = buildOutcome([claimOne, claimTwo]);

    const report = service.verify({
      outcome,
      retrievedChunks: [CHUNK, OTHER_CHUNK],
      cellFacts,
      conflictedFactKeys: [factKeyOne, factKeyTwo],
    });

    expect(report.outcomeKind).toBe('conflicting_evidence');
    expect(report.conflictingFactKey).toEqual(factKeyOne);
  });
});

describe('factKeysMatch', () => {
  const keyFor = (entity: string): FactKey => ({ entity, metric: 'cap_rate', period: '2025-03' });
  const withChar = (template: string, codePoint: number) =>
    template.replace('_', String.fromCodePoint(codePoint));

  it('should match entities that are equal after normalizeEntityName folds them', () => {
    expect(factKeysMatch(keyFor('Acme'), keyFor('  ACME  '))).toBe(true);
  });

  it('should key through the same normalization groupKey (detect-conflicts.ts) uses', () => {
    expect(factKeysMatch(keyFor('Acme  Tower'), keyFor(normalizeEntityName('Acme  Tower')))).toBe(
      true,
    );
  });

  // The normalization class, swept rather than sampled — mirrors `groupKey`'s own sweep in
  // `detect-conflicts.spec.ts`, since both functions are contracted to fold entities identically.
  // A single spacing or compatibility character that survives one fold and not the other makes this
  // gate refuse a fact key that grouping already treats as the same entity.
  describe('names that differ only by a fold normalizeEntityName performs', () => {
    it('should match on every Unicode space-separator code point, including the ones NFKC leaves alone', () => {
      const spaceSeparators: string[] = [];
      for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
        const char = String.fromCodePoint(codePoint);
        if (/\p{Zs}/u.test(char)) {
          spaceSeparators.push(char);
        }
      }
      // Pinned, not sampled: a Unicode revision that adds a space separator must fail here so the
      // new code point is checked against this normalization rather than reaching it unexamined.
      expect(spaceSeparators).toHaveLength(17);

      for (const separator of spaceSeparators) {
        const rendered = `Acme${separator}${separator}Tower`;
        expect([
          separator.codePointAt(0),
          factKeysMatch(keyFor(rendered), keyFor('Acme Tower')),
        ]).toEqual([separator.codePointAt(0), true]);
      }
    });

    it.each([
      ['fullwidth letters a PDF text layer emits', 'Ａｃｍｅ Ｔｏｗｅｒ'],
      ['a compatibility ligature', 'Oﬃce Tower'],
      ['a no-break space', withChar('Acme_Tower', 0x00a0)],
      ['an ideographic space', withChar('Acme_Tower', 0x3000)],
      ['a narrow no-break space', withChar('Acme_Tower', 0x202f)],
      ['an Ogham space mark, which NFKC leaves alone', withChar('Acme_Tower', 0x1680)],
      ['a superscript digit', withChar('Acme Tower_', 0x00b2)],
      ['a Roman numeral', withChar('Acme Tower _', 0x2171)],
      ['mixed casing and a whitespace run', '  ACME \t Tower  '],
    ])('should match %s against its plain-ASCII form', (_description, rendered) => {
      expect(factKeysMatch(keyFor(rendered), keyFor(normalizeEntityName(rendered)))).toBe(true);
    });
  });

  // The other half of the class: folding too much would match two entities that were never the
  // same. `factKeysMatch` inherits this refusal from `normalizeEntityName` rather than enforcing it
  // itself, so the sweep asserts the inherited behavior stays in place.
  it.each([
    ['Acme Tower', 'Acme Towers'],
    ['Acme Tower', 'AcmeTower'],
    ['Acme Tower', 'Acme-Tower'],
    ['Acme Tower', 'Acme Tower II'],
    ['Northgate Business Park', 'Northgate Bus. Park'],
  ])('should NOT match %p and %p', (left, right) => {
    expect(factKeysMatch(keyFor(left), keyFor(right))).toBe(false);
  });

  it('should require metric to match exactly, even when entity matches', () => {
    expect(
      factKeysMatch(
        { entity: 'Acme', metric: 'cap_rate', period: '2025-03' },
        { entity: 'Acme', metric: 'sale_price', period: '2025-03' },
      ),
    ).toBe(false);
  });

  it('should require period to match exactly, even when entity matches', () => {
    expect(
      factKeysMatch(
        { entity: 'Acme', metric: 'cap_rate', period: '2025-03' },
        { entity: 'Acme', metric: 'cap_rate', period: '2025-04' },
      ),
    ).toBe(false);
  });

  // The closing assertion for the class: agreement with `groupKey`, an independent implementation
  // of the same fold, rather than agreement with the normalization this function itself now calls.
  // A pool covering every fold variant exercised above plus every "kept apart" pair, compared
  // pairwise so a future change to either function's normalization is caught here even if it never
  // touches this file.
  it('should agree with groupKey on every pair drawn from the fold-and-distinct pool', () => {
    const pool = [
      'Acme Tower',
      '  ACME  ',
      'Ａｃｍｅ Ｔｏｗｅｒ',
      'Oﬃce Tower',
      withChar('Acme_Tower', 0x00a0),
      withChar('Acme_Tower', 0x3000),
      withChar('Acme_Tower', 0x202f),
      withChar('Acme_Tower', 0x1680),
      withChar('Acme Tower_', 0x00b2),
      withChar('Acme Tower _', 0x2171),
      '  ACME \t Tower  ',
      'Acme Towers',
      'AcmeTower',
      'Acme-Tower',
      'Acme Tower II',
      'Northgate Business Park',
      'Northgate Bus. Park',
    ];
    const groupKeyFor = (entity: string) =>
      groupKey({ entity, metric: 'cap_rate', period: '2025-03' });

    for (const left of pool) {
      for (const right of pool) {
        const expected = groupKeyFor(left) === groupKeyFor(right);
        expect([left, right, factKeysMatch(keyFor(left), keyFor(right))]).toEqual([
          left,
          right,
          expected,
        ]);
      }
    }
  });
});
