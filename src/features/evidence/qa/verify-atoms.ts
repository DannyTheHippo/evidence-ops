import { extractContentTokens } from './check-quote-alignment';
import type { Claim } from './contracts/answer.contract';
import type { ClaimVerificationResult } from './verify-claim';

/**
 * Verifies a claim's model-decomposed atoms without letting decomposition become the primary
 * grounding path (see the phase's architecture decision on why atoms-as-primary was rejected: a
 * lazy decomposition that quietly drops a false rider would pass). Two invariants hold by
 * construction here, not by convention:
 *
 * 1. **Monotonicity: survived-with-atoms implies survived-without-atoms.** {@link verifyAtoms}
 *    always verifies the whole claim first. Only a claim that already survived on its own, and
 *    whose atoms cover it (see {@link checkAtomCoverage}), is then checked per atom. This ordering
 *    is what makes decomposition unable to launder a claim through: an omitted false rider can never
 *    turn a dropped claim into a survived one, because the whole claim ran first and already
 *    dropped it on its own account.
 * 2. **An incomplete decomposition falls back to the whole-claim result, never to a looser check.**
 *    Coverage is two-directional — every content token the claim asserts must appear in some atom,
 *    and no atom may introduce a content token the claim itself does not assert — and either
 *    failure returns the whole-claim result unchanged, counted as `coverageFallback: true` rather
 *    than silently accepted or silently tightened.
 */

/**
 * Whether `atoms` covers `statement`'s content, in both directions: `uncoveredTokens` is every
 * content token (`extractContentTokens`) `statement` asserts that no atom repeats, and
 * `extraneousTokens` is every content token some atom introduces that `statement` itself does not
 * assert — a decomposition that added an unstated number or name is exactly as untrustworthy as one
 * that silently dropped a rider. `covered` requires both lists to be empty and at least one atom; an
 * empty `atoms` array is never covered, regardless of `statement`.
 */
export function checkAtomCoverage(
  statement: string,
  atoms: readonly string[],
): { covered: boolean; uncoveredTokens: string[]; extraneousTokens: string[] } {
  const claimTokens = extractContentTokens(statement);
  const atomTokens = new Set<string>();
  for (const atom of atoms) {
    for (const token of extractContentTokens(atom)) atomTokens.add(token);
  }

  const uncoveredTokens = [...claimTokens].filter((token) => !atomTokens.has(token));
  const extraneousTokens = [...atomTokens].filter((token) => !claimTokens.has(token));

  return {
    covered: atoms.length > 0 && uncoveredTokens.length === 0 && extraneousTokens.length === 0,
    uncoveredTokens,
    extraneousTokens,
  };
}

/**
 * Verifies `claim` by first verifying its whole statement with `verifyStatement`, then — only when
 * that survived and `atoms` covers it — verifying each atom in the same way, dropping the claim on
 * the first unsupported atom. See the module doc comment for the two invariants this ordering
 * establishes. `verifyStatement` is injected so this module stays free of `verify-claim.ts`'s own
 * dependencies (retrieval, cell facts, subject binding); the caller supplies `verifyClaim` bound to
 * a statement-only wrapper.
 */
export function verifyAtoms(input: {
  readonly claim: Claim;
  readonly atoms: readonly string[];
  readonly verifyStatement: (statement: string) => ClaimVerificationResult;
}): ClaimVerificationResult & {
  readonly atomization: { coverageFallback: boolean; atomDropped: boolean };
} {
  const { claim, atoms, verifyStatement } = input;
  const whole = verifyStatement(claim.statement);

  if (whole.kind === 'dropped') {
    return { ...whole, atomization: { coverageFallback: false, atomDropped: false } };
  }

  const coverage = checkAtomCoverage(claim.statement, atoms);
  if (!coverage.covered) {
    return { ...whole, atomization: { coverageFallback: true, atomDropped: false } };
  }

  for (const atom of atoms) {
    const atomResult = verifyStatement(atom);
    if (atomResult.kind === 'dropped') {
      const detail = `atom '${atom}' is not supported: ${atomResult.dropped.reason}`;
      return {
        kind: 'dropped',
        dropped: { statement: claim.statement, reason: detail },
        violations: [
          { kind: 'atom-unsupported', claimStatement: claim.statement, detail },
          ...atomResult.violations,
        ],
        touchedFactKeys: [],
        atomization: { coverageFallback: false, atomDropped: true },
      };
    }
  }

  return { ...whole, atomization: { coverageFallback: false, atomDropped: false } };
}
