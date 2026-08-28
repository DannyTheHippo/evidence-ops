import { batchClaims } from '../../../../scripts/experiments/verifier/batch-claims';
import { joinVerdicts } from '../../../../scripts/experiments/verifier/join-verdicts';
import type { VerifyClaimResult } from '../../../../src/features/evidence/qa/contracts/verify-claims.contract';
import { makeDraftedClaim } from './verifier-fixtures';

describe('joinVerdicts', () => {
  const batch = [
    makeDraftedClaim({ claimId: 'c001', statement: 'first' }),
    makeDraftedClaim({ claimId: 'c002', statement: 'second' }),
  ];

  it('attaches each result to the claim its batch-local index names', () => {
    const results: VerifyClaimResult[] = [
      { claimIndex: 1, verdict: 'not_grounded', reasonCode: 'quote-not-found' },
      { claimIndex: 0, verdict: 'grounded' },
    ];

    expect(joinVerdicts(batch, results)).toEqual([
      { ...batch[0], verdict: 'grounded', reasonCode: undefined, citations: undefined },
      {
        ...batch[1],
        verdict: 'not_grounded',
        reasonCode: 'quote-not-found',
        citations: undefined,
      },
    ]);
  });

  it('maps a later batch onto its own claims rather than the first batch', () => {
    const claims = Array.from({ length: 25 }, (_, index) =>
      makeDraftedClaim({ claimId: `c${String(index + 1).padStart(3, '0')}` }),
    );
    const batches = batchClaims(claims, 10);
    const results: VerifyClaimResult[] = batches[2].map((_, index) => ({
      claimIndex: index,
      verdict: 'grounded',
    }));

    const joined = joinVerdicts(batches[2], results);

    expect(joined.map((outcome) => outcome.claimId)).toEqual([
      'c021',
      'c022',
      'c023',
      'c024',
      'c025',
    ]);
  });

  it('refuses a result count that does not match the batch', () => {
    expect(() => joinVerdicts(batch, [{ claimIndex: 0, verdict: 'grounded' }])).toThrow(
      'expected 2 result(s)',
    );
  });

  it('refuses a claimIndex outside the batch', () => {
    const results: VerifyClaimResult[] = [
      { claimIndex: 0, verdict: 'grounded' },
      { claimIndex: 7, verdict: 'grounded' },
    ];

    expect(() => joinVerdicts(batch, results)).toThrow('outside the 2-claim batch');
  });

  it('refuses a duplicated claimIndex', () => {
    const results: VerifyClaimResult[] = [
      { claimIndex: 0, verdict: 'grounded' },
      { claimIndex: 0, verdict: 'not_grounded' },
    ];

    expect(() => joinVerdicts(batch, results)).toThrow('duplicate result for claimIndex 0');
  });
});
