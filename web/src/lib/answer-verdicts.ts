import type {
  AttestationClaim,
  ClaimVerdict,
  ConflictResolution,
  VerifyClaimResult,
} from '../api/client';

/** The label each verification verdict renders as, in the order a tally line lists them. */
export const VERDICT_LABELS: Record<ClaimVerdict, string> = {
  grounded: 'grounded',
  not_grounded: 'not grounded',
  no_evidence_retrieved: 'no evidence retrieved',
  conflicting_evidence: 'conflicting evidence',
};

/** Tallies a verification run's per-claim verdicts into one mono line, in `VERDICT_LABELS`
 * order, omitting any verdict no claim in the run reached. */
export function verdictTally(results: VerifyClaimResult[]): string {
  const counts = new Map<ClaimVerdict, number>();
  for (const result of results) {
    counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  }
  return (Object.keys(VERDICT_LABELS) as ClaimVerdict[])
    .filter((verdict) => (counts.get(verdict) ?? 0) > 0)
    .map((verdict) => `${counts.get(verdict)} ${VERDICT_LABELS[verdict]}`)
    .join(' · ');
}

/** The label each attestation claim verdict renders as. A superset of `VERDICT_LABELS`: an
 * attestation bundle also carries `survived` and `dropped`, verdicts a submitted verification
 * never reaches. */
export const BUNDLE_VERDICT_LABELS: Record<AttestationClaim['verdict'], string> = {
  grounded: 'grounded',
  survived: 'survived',
  not_grounded: 'not grounded',
  dropped: 'dropped',
  no_evidence_retrieved: 'no evidence retrieved',
  conflicting_evidence: 'conflicting evidence',
};

/** The label an answer's outcome kind renders as. `raw` is `string | null` on the wire — a bundle
 * carries no outcome for a verification subject or an answer with none yet — so `null` renders
 * `'—'` and a kind this build does not recognise renders as itself rather than being dropped. */
export function answerOutcomeLabel(raw: string | null): string {
  if (raw === null) return '—';
  switch (raw) {
    case 'answered':
      return 'answered';
    case 'insufficient_evidence':
      return 'insufficient evidence';
    case 'conflicting_evidence':
      return 'conflicting evidence';
    default:
      return raw;
  }
}

/** The label each ledger decision outcome renders as. */
export const DECISION_OUTCOME_LABELS: Record<ConflictResolution['outcome'], string> = {
  resolved: 'resolved',
  rejected: 'rejected',
  timed_out: 'timed out',
  superseded: 'superseded',
  retracted: 'retracted',
};
