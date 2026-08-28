import type { AnswerOutcome, Citation, VerificationReport } from '../api/client';
import type { ResolvedVersion } from '../lib/document-index';
import { metricLabel, useMetricLabels } from '../lib/metric-labels';

interface VerificationLedgerProps {
  outcome: AnswerOutcome;
  verificationReport?: VerificationReport;
  retrievedChunkCount?: number;
  documentIndex?: Map<string, ResolvedVersion>;
}

// A spreadsheet locator kind is unambiguous, but a csv/tsv document can chunk as `text-block` —
// there is no dedicated locator kind for it — so a citation only reads as tabular once its
// document's own `sourceKind` is checked too. `documentIndex` may still be filling in
// asynchronously or may never resolve an id (see `resolveDocumentVersions`), so this under-detects
// on those citations rather than over-claiming a source kind it cannot see.
const TABULAR_LOCATOR_KINDS = new Set(['xlsx-cell', 'xlsx-region']);
const TABULAR_SOURCE_KINDS = new Set(['xlsx', 'csv', 'tsv']);

function isTabularCitation(citation: Citation, documentIndex?: Map<string, ResolvedVersion>) {
  if (TABULAR_LOCATOR_KINDS.has(citation.locator.kind)) return true;
  const sourceKind = documentIndex?.get(citation.docVersionId)?.sourceKind;
  return sourceKind !== undefined && TABULAR_SOURCE_KINDS.has(sourceKind);
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
 * "Verified against the source" describes what the grounding check did to a claim, not a
 * guarantee that its evidence was tabular-safe to check: a verified claim whose citation comes
 * from a spreadsheet, CSV, or TSV document gets a second, plainer line naming that — `documentIndex`
 * is optional so a caller that has not resolved it yet still renders the ratio, just without that
 * qualifier until it does.
 *
 * Presentational apart from resolving the metric label shown for a `conflicting_evidence`
 * outcome — `useMetricLabels()` reads a module-scope cache the ontology fetch fills at most once
 * per browser session, so this component still triggers no fetch of its own.
 */
export default function VerificationLedger({
  outcome,
  verificationReport,
  retrievedChunkCount,
  documentIndex,
}: VerificationLedgerProps) {
  const metricLabels = useMetricLabels();
  const retrievedLine =
    typeof retrievedChunkCount === 'number' ? (
      <p className="ledger-line ledger-line--input">
        {retrievedChunkCount} chunk{retrievedChunkCount === 1 ? '' : 's'} retrieved
      </p>
    ) : null;

  if (outcome.kind === 'conflicting_evidence') {
    return (
      <div className="ledger">
        {retrievedLine}
        <p className="ledger-line">
          Contradiction found for {outcome.factKey.entity} —{' '}
          {metricLabel(outcome.factKey.metric, metricLabels)} ({outcome.factKey.period})
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
  // `outcome.claims` carries only the claims that survived verification, so counting a tabular
  // citation here counts a tabular claim among the ones this ratio calls "verified" — never among
  // `droppedClaims`, which carries no citation and so cannot be checked for source kind at all.
  const tabularVerifiedClaimCount =
    outcome.kind === 'answered'
      ? outcome.claims.filter((claim) =>
          claim.citations.some((citation) => isTabularCitation(citation, documentIndex)),
        ).length
      : 0;

  return (
    <div className="ledger">
      {retrievedLine}
      <p className="ledger-line ledger-line--input">
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
      <div
        className={`ledger-outcome ${notAssertedCount === 0 ? 'ledger-outcome--verified' : 'ledger-outcome--caution'}`}
      >
        <p className="ledger-line ledger-line--outcome">
          {verifiedClaimCount} of {totalClaimCount} claim{totalClaimCount === 1 ? '' : 's'} verified
          against the source
        </p>
        {notAssertedCount > 0 && <p className="ledger-line">{notAssertedCount} not asserted</p>}
        {tabularVerifiedClaimCount > 0 && (
          <p className="ledger-line">
            {tabularVerifiedClaimCount} verified claim{tabularVerifiedClaimCount === 1 ? '' : 's'}{' '}
            sourced from a spreadsheet or CSV — not verified against the source table
          </p>
        )}
        {/* A bare "0 of N verified" ratio reads as total failure rather than the grounding
            check's protective degradation; every other ratio is self-explanatory alongside the
            bar and needs no elaboration. A dropped claim did not pass the check — it is not
            established that its underlying statement lacks support in the source. */}
        {verifiedClaimCount === 0 && totalClaimCount > 0 && (
          <p className="notice notice--warn">
            None of the asserted claims passed the grounding check; every one was dropped.
          </p>
        )}
      </div>
    </div>
  );
}
