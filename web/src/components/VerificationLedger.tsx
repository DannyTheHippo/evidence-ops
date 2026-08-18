import type { AnswerOutcome, VerificationReport } from '../api/client';

interface VerificationLedgerProps {
  outcome: AnswerOutcome;
  verificationReport?: VerificationReport;
  retrievedChunkCount?: number;
}

/**
 * The retrieval-to-verification funnel at the head of every completed answer: chunks retrieved,
 * claims asserted, claims verified against the source, and claims not asserted. It is the single
 * surface stating what the product actually did to the answer, so the coverage figure and the
 * verification headline read as one thing rather than two separated by the length of the page.
 *
 * Copy is keyed on report presence, not `outcome.kind` alone. `verificationReport` is built only
 * on the path that started from a model-authored `answered` outcome (`activities.ts`'s
 * `groundingCheck` activity), so it is present for `answered` and for the grounding gate's own
 * degraded `insufficient_evidence` (every asserted claim dropped), and absent for a
 * model-authored `insufficient_evidence` abstention and for a `conflicting_evidence` outcome the
 * model itself proposed. `conflicting_evidence` never renders a claim ratio, report present or
 * not — its counts, where they exist, describe claims the outcome does not render.
 *
 * Purely presentational: no fetching, no effects.
 */
export default function VerificationLedger({
  outcome,
  verificationReport,
  retrievedChunkCount,
}: VerificationLedgerProps) {
  const retrievedLine =
    typeof retrievedChunkCount === 'number' ? (
      <p className="ledger-line">
        {retrievedChunkCount} chunk{retrievedChunkCount === 1 ? '' : 's'} retrieved
      </p>
    ) : null;

  if (outcome.kind === 'conflicting_evidence') {
    return (
      <div className="ledger">
        {retrievedLine}
        <p className="ledger-line">
          Contradiction found for {outcome.factKey.entity} — {outcome.factKey.metric} (
          {outcome.factKey.period})
        </p>
      </div>
    );
  }

  if (!verificationReport) {
    return (
      <div className="ledger">
        {retrievedLine}
        {outcome.kind === 'insufficient_evidence' && (
          <p className="ledger-line">
            No claims asserted — the model found insufficient evidence to answer.
          </p>
        )}
      </div>
    );
  }

  const { verifiedClaimCount, totalClaimCount, droppedClaims } = verificationReport;
  const notAssertedCount = droppedClaims.length;

  return (
    <div className="ledger">
      {retrievedLine}
      <p className="ledger-line">
        {totalClaimCount} claim{totalClaimCount === 1 ? '' : 's'} asserted
      </p>
      {totalClaimCount > 0 && (
        // One segment per claim rather than a computed width — state stays on modifier classes,
        // not an inline style, and the row divides proportionally on flex alone.
        <div className="ledger-bar" aria-hidden="true">
          {Array.from({ length: verifiedClaimCount }, (_, index) => (
            <span
              key={`verified-${index}`}
              className="ledger-bar-segment ledger-bar-segment--verified"
            />
          ))}
          {Array.from({ length: notAssertedCount }, (_, index) => (
            <span
              key={`caution-${index}`}
              className="ledger-bar-segment ledger-bar-segment--caution"
            />
          ))}
        </div>
      )}
      <p className="ledger-line">
        {verifiedClaimCount} of {totalClaimCount} claims verified against the source
      </p>
      <p className="ledger-line">{notAssertedCount} not asserted</p>
      {notAssertedCount === 0 && (
        <p className="notice notice--ok">
          Every claim in this answer was checked against the source and verified.
        </p>
      )}
    </div>
  );
}
