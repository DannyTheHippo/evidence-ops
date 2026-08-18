import type { Answer, Locator } from '../api/client';
import type { ResolvedVersion } from '../lib/document-index';
import { formatLocator } from '../lib/locator';
import ProvenanceRail from './ProvenanceRail';

/** A conflicting_evidence value's source chunk resolved to the document version and locator it
 * came from, keyed by `sourceChunkId` — built by the caller from `listConflicts()`, narrowed to
 * the answer's own `conflictIds`. */
export interface ConflictChunkResolution {
  documentVersionId: string;
  locator: Locator;
}

interface AnswerViewProps {
  answer: Answer;
  documentIndex: Map<string, ResolvedVersion>;
  conflictChunkIndex: Map<string, ConflictChunkResolution>;
}

/**
 * The completed-answer presentation shared by AskPage's live view and AnswerDetailPage's
 * historical view: the provenance rail for `answered`/`insufficient_evidence`, the value-compare
 * markup for `conflicting_evidence` (the rail's node for that outcome states only the fact key,
 * not the compared values or their resolved sources), and the verification panel disclosing any
 * dropped claims. Renders nothing for an answer that isn't `completed` or carries no outcome yet
 * — the caller owns showing that state itself.
 *
 * Purely presentational: no fetching, no effects. The caller resolves and passes `documentIndex`
 * (`buildDocumentVersionIndex()`) and `conflictChunkIndex`.
 */
export default function AnswerView({ answer, documentIndex, conflictChunkIndex }: AnswerViewProps) {
  if (answer.runStatus !== 'completed' || !answer.outcome) return null;

  return (
    <div className="answer-outcome">
      {typeof answer.claimCoverage === 'number' && (
        <p className="card-meta">Claim coverage: {Math.round(answer.claimCoverage * 100)}%</p>
      )}

      {answer.outcome.kind !== 'conflicting_evidence' && (
        <ProvenanceRail outcome={answer.outcome} documentIndex={documentIndex} />
      )}

      {answer.outcome.kind === 'conflicting_evidence' && (
        <div className="conflict-block">
          <p className="card-meta">
            {answer.outcome.factKey.entity} — {answer.outcome.factKey.metric} (
            {answer.outcome.factKey.period})
          </p>
          <ul className="value-compare">
            {answer.outcome.values.map((value, valueIndex) => {
              const chunkResolution = conflictChunkIndex.get(value.sourceChunkId);
              const resolvedVersion =
                chunkResolution && documentIndex.get(chunkResolution.documentVersionId);
              const sourceLabel = resolvedVersion
                ? `${resolvedVersion.documentTitle} — ${formatLocator(chunkResolution.locator)}`
                : value.sourceChunkId;
              return (
                <li key={valueIndex} className="value-compare-item">
                  <span className="mono">
                    {value.value} {value.unit}
                  </span>
                  <span className="cell-sub">{sourceLabel}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {answer.verificationReport && (
        <div className="verification">
          <p className="verification-headline">
            {answer.verificationReport.verifiedClaimCount} of{' '}
            {answer.verificationReport.totalClaimCount} claims verified against the source
          </p>
          {answer.verificationReport.droppedClaims.length > 0 ? (
            <details>
              <summary>
                {answer.verificationReport.droppedClaims.length} claim
                {answer.verificationReport.droppedClaims.length === 1 ? '' : 's'} dropped — not
                verified against the source
              </summary>
              {answer.verificationReport.droppedClaims.map((dropped, droppedIndex) => (
                <div key={droppedIndex}>
                  <p className="claim-statement">{dropped.statement}</p>
                  <p className="field-error">{dropped.reason}</p>
                </div>
              ))}
            </details>
          ) : (
            <p className="notice notice--ok">
              Every claim in this answer was checked against the source and verified.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
