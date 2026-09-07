import type {
  Citation,
  Claim,
} from '../../../../src/features/evidence/qa/contracts/answer.contract';
import type { ClaimVerificationResult } from '../../../../src/features/evidence/qa/verify-claim';
import { checkAtomCoverage, verifyAtoms } from '../../../../src/features/evidence/qa/verify-atoms';

const SHA256_A = 'a'.repeat(64);

function buildCitation(): Citation {
  return {
    docVersionId: 'doc-v1',
    sha256: SHA256_A,
    chunkId: 'chunk-1',
    locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 1 },
    quote: 'stub quote',
  };
}

function buildClaim(statement: string): Claim {
  return { statement, citations: [buildCitation()] };
}

function survived(statement: string): ClaimVerificationResult {
  return {
    kind: 'survived',
    claim: buildClaim(statement),
    violations: [],
    touchedFactKeys: [],
  };
}

function dropped(statement: string, reason = 'stub dropped'): ClaimVerificationResult {
  return {
    kind: 'dropped',
    dropped: { statement, reason },
    violations: [{ kind: 'numeric-claim-unsupported', claimStatement: statement, detail: reason }],
    touchedFactKeys: [],
  };
}

describe('checkAtomCoverage', () => {
  it('is uncovered when the atoms omit a content token the claim asserts', () => {
    const result = checkAtomCoverage('Alpha bravo charlie delta', ['Alpha bravo']);
    expect(result.covered).toBe(false);
    expect(result.uncoveredTokens).toEqual(['charlie', 'delta']);
    expect(result.extraneousTokens).toEqual([]);
  });

  it('is uncovered when an atom introduces a content token the claim does not assert', () => {
    const result = checkAtomCoverage('Alpha bravo', ['Alpha bravo charlie']);
    expect(result.covered).toBe(false);
    expect(result.uncoveredTokens).toEqual([]);
    expect(result.extraneousTokens).toEqual(['charlie']);
  });

  it('is uncovered on an empty atom list regardless of the statement', () => {
    const result = checkAtomCoverage('Alpha bravo', []);
    expect(result.covered).toBe(false);
    expect(result.uncoveredTokens).toEqual(['alpha', 'bravo']);
  });

  it('is covered when the atoms exactly partition the claim content tokens', () => {
    const result = checkAtomCoverage('Alpha bravo charlie delta', ['Alpha bravo', 'Charlie delta']);
    expect(result).toEqual({ covered: true, uncoveredTokens: [], extraneousTokens: [] });
  });
});

describe('verifyAtoms — monotonicity property', () => {
  const CLAIM_STATEMENT = 'Alpha bravo charlie delta';

  type WholeOutcome = 'survived' | 'dropped';
  type AtomCoverage = 'full' | 'omit' | 'add' | 'empty';
  type AtomOutcome = 'all-survived' | 'first-dropped';

  function atomsFor(coverage: AtomCoverage): string[] {
    switch (coverage) {
      case 'full':
        return ['Alpha bravo', 'Charlie delta'];
      case 'omit':
        return ['Alpha bravo'];
      case 'add':
        return ['Alpha bravo charlie delta echo'];
      case 'empty':
        return [];
    }
  }

  const WHOLE_OUTCOMES: WholeOutcome[] = ['survived', 'dropped'];
  const ATOM_COVERAGES: AtomCoverage[] = ['full', 'omit', 'add', 'empty'];
  const ATOM_OUTCOMES: AtomOutcome[] = ['all-survived', 'first-dropped'];

  const grid = WHOLE_OUTCOMES.flatMap((wholeOutcome) =>
    ATOM_COVERAGES.flatMap((atomCoverage) =>
      ATOM_OUTCOMES.map((atomOutcome) => ({ wholeOutcome, atomCoverage, atomOutcome })),
    ),
  );

  it.each(grid)(
    'whole=$wholeOutcome coverage=$atomCoverage atoms=$atomOutcome',
    ({ wholeOutcome, atomCoverage, atomOutcome }) => {
      const atoms = atomsFor(atomCoverage);
      const wholeStub = (statement: string): ClaimVerificationResult =>
        wholeOutcome === 'survived' ? survived(statement) : dropped(statement);
      const verifyStatement = (statement: string): ClaimVerificationResult => {
        if (statement === CLAIM_STATEMENT) return wholeStub(statement);
        // atom-level result: 'first-dropped' drops only the first atom this stub is asked about.
        const isFirstAtom = atoms.indexOf(statement) === 0;
        return atomOutcome === 'first-dropped' && isFirstAtom
          ? dropped(statement)
          : survived(statement);
      };

      const result = verifyAtoms({ claim: buildClaim(CLAIM_STATEMENT), atoms, verifyStatement });

      if (result.kind === 'survived') {
        expect(wholeStub(CLAIM_STATEMENT).kind).toBe('survived');
      }
    },
  );

  it('covers every combination of whole outcome, atom coverage, and atom outcome', () => {
    expect(grid).toHaveLength(WHOLE_OUTCOMES.length * ATOM_COVERAGES.length * ATOM_OUTCOMES.length);
    expect(grid).toHaveLength(16);
  });
});

describe('verifyAtoms — named cases', () => {
  const RIDER_STATEMENT =
    'Northgate Business Park traded in March 2025, and its chief executive was arrested';
  const FIRST_ATOM = 'Northgate Business Park traded in March 2025';
  const SECOND_ATOM = 'its chief executive was arrested';

  it('drops the claim with an atom-unsupported violation naming the false rider (ADR-0020)', () => {
    const claim = buildClaim(RIDER_STATEMENT);
    const verifyStatement = jest.fn((statement: string): ClaimVerificationResult =>
      statement === SECOND_ATOM
        ? dropped(statement, 'no evidence names an arrest')
        : survived(statement),
    );

    const result = verifyAtoms({ claim, atoms: [FIRST_ATOM, SECOND_ATOM], verifyStatement });

    expect(result.kind).toBe('dropped');
    if (result.kind !== 'dropped') throw new Error('unreachable');
    expect(result.atomization).toEqual({ coverageFallback: false, atomDropped: true });
    expect(result.violations[0].kind).toBe('atom-unsupported');
    expect(result.violations[0].detail).toContain(SECOND_ATOM);
    expect(result.dropped.reason).toContain(SECOND_ATOM);
  });

  it('falls back to the whole-claim result, deep-equal, when a lazy decomposition omits the rider', () => {
    const claim = buildClaim(RIDER_STATEMENT);
    const wholeResult = survived(RIDER_STATEMENT);
    const verifyStatement = jest.fn((statement: string): ClaimVerificationResult =>
      statement === RIDER_STATEMENT ? wholeResult : survived(statement),
    );

    const result = verifyAtoms({ claim, atoms: [FIRST_ATOM], verifyStatement });

    expect(result.atomization).toEqual({ coverageFallback: true, atomDropped: false });
    expect(result).toMatchObject(wholeResult);
  });

  it('falls back when an atom introduces a number the claim does not state', () => {
    const claim = buildClaim('Rent increased last year');
    const wholeResult = survived(claim.statement);
    const verifyStatement = jest.fn((statement: string): ClaimVerificationResult =>
      statement === claim.statement ? wholeResult : survived(statement),
    );

    const result = verifyAtoms({
      claim,
      atoms: ['Rent increased 5% last year'],
      verifyStatement,
    });

    expect(result.atomization).toEqual({ coverageFallback: true, atomDropped: false });
    expect(result).toMatchObject(wholeResult);
  });

  it('falls back when atoms is empty', () => {
    const claim = buildClaim('Alpha bravo charlie');
    const wholeResult = survived(claim.statement);
    const verifyStatement = jest.fn(() => wholeResult);

    const result = verifyAtoms({ claim, atoms: [], verifyStatement });

    expect(result.atomization).toEqual({ coverageFallback: true, atomDropped: false });
    expect(result).toMatchObject(wholeResult);
  });

  it('calls verifyStatement on the whole claim exactly once, before any atom', () => {
    const claim = buildClaim(RIDER_STATEMENT);
    const calls: string[] = [];
    const verifyStatement = jest.fn((statement: string): ClaimVerificationResult => {
      calls.push(statement);
      return survived(statement);
    });

    verifyAtoms({ claim, atoms: [FIRST_ATOM, SECOND_ATOM], verifyStatement });

    expect(calls.filter((statement) => statement === RIDER_STATEMENT)).toHaveLength(1);
    expect(calls[0]).toBe(RIDER_STATEMENT);
  });

  it('never reads atoms when the whole claim is already dropped', () => {
    const claim = buildClaim('Alpha bravo charlie');
    const verifyStatement = jest.fn((statement: string): ClaimVerificationResult =>
      statement === claim.statement ? dropped(statement) : survived(statement),
    );

    const result = verifyAtoms({ claim, atoms: ['Alpha bravo charlie'], verifyStatement });

    expect(result.kind).toBe('dropped');
    expect(result.atomization).toEqual({ coverageFallback: false, atomDropped: false });
    expect(verifyStatement).toHaveBeenCalledTimes(1);
  });
});
