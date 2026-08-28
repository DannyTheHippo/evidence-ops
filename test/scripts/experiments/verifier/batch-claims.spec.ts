import { batchClaims } from '../../../../scripts/experiments/verifier/batch-claims';
import { makeDraftedClaim } from './verifier-fixtures';

describe('batchClaims', () => {
  const claims = Array.from({ length: 23 }, (_, index) =>
    makeDraftedClaim({ claimId: `c${String(index + 1).padStart(3, '0')}` }),
  );

  it('splits into full batches plus a remainder, preserving order', () => {
    const batches = batchClaims(claims, 10);

    expect(batches.map((batch) => batch.length)).toEqual([10, 10, 3]);
    expect(batches.flat().map((claim) => claim.claimId)).toEqual(
      claims.map((claim) => claim.claimId),
    );
  });

  it('returns no batches for no claims', () => {
    expect(batchClaims([], 10)).toEqual([]);
  });

  it('emits one batch when the claim count is under the bound', () => {
    expect(batchClaims(claims.slice(0, 4), 10)).toHaveLength(1);
  });

  it('emits exactly one batch when the claim count equals the bound', () => {
    const batches = batchClaims(claims.slice(0, 10), 10);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(10);
  });

  it.each([0, -1, 2.5])('refuses a maxBatchSize of %p', (size) => {
    expect(() => batchClaims(claims, size)).toThrow('positive integer');
  });
});
