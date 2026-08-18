import type { Answer, DroppedClaim, Locator } from '../api/client';
import type { ResolvedVersion } from '../lib/document-index';
import { formatLocator } from '../lib/locator';
import ProvenanceRail from './ProvenanceRail';
import VerificationLedger from './VerificationLedger';

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

interface DroppedClaimsBandProps {
  droppedClaims: DroppedClaim[];
  isAbstention: boolean;
}

// A dropped statement is model text that failed verification, and this codebase deliberately
// closes every other model free-text channel (`answer.contract.ts`'s `reasonCode` enum is the
// same discipline applied to the abstention reason) — so the count and the server-authored
// `reason` stay always visible, and only the raw `statement` sits behind a disclosure, one per
// claim. Renders nothing once there is nothing dropped to show.
function DroppedClaimsBand({ droppedClaims, isAbstention }: DroppedClaimsBandProps) {
  if (droppedClaims.length === 0) return null;

  // The grounding gate's own degraded `insufficient_evidence` drops every asserted claim, which
  // would otherwise make an "N claims dropped" framing read as a partial failure among a longer
  // list rather than the reason the model abstained.
  const headline = isAbstention
    ? 'No claim could be verified against the source — this is why the model abstained.'
    : `${droppedClaims.length} claim${droppedClaims.length === 1 ? '' : 's'} dropped — not verified against the source`;

  return (
    <div className="notice notice--warn">
      <div>
        <p className="dropped-claims-headline">{headline}</p>
        <ul className="dropped-claims-list">
          {droppedClaims.map((dropped, droppedIndex) => (
            <li key={droppedIndex} className="dropped-claim">
              <p className="dropped-claim-reason">{dropped.reason}</p>
              <details className="dropped-claim-disclosure">
                <summary>Show statement</summary>
                <p className="dropped-claim-statement">{dropped.statement}</p>
              </details>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The completed-answer presentation shared by AskPage's live view and AnswerDetailPage's
 * historical view: the verification ledger's retrieval funnel, the provenance rail for
 * `answered`/`insufficient_evidence`, the value-compare markup for `conflicting_evidence` (the
 * rail's node for that outcome states only the fact key, not the compared values or their
 * resolved sources), and a band disclosing any dropped claims. Renders nothing for an answer that
 * isn't `completed` or carries no outcome yet — the caller owns showing that state itself.
 *
 * Purely presentational: no fetching, no effects. The caller resolves and passes `documentIndex`
 * (`buildDocumentVersionIndex()`) and `conflictChunkIndex`.
 */
export default function AnswerView({ answer, documentIndex, conflictChunkIndex }: AnswerViewProps) {
  if (answer.runStatus !== 'completed' || !answer.outcome) return null;

  return (
    <div className="answer-outcome">
      <VerificationLedger
        outcome={answer.outcome}
        verificationReport={answer.verificationReport}
        retrievedChunkCount={answer.retrievedChunkCount}
      />

      {answer.outcome.kind !== 'conflicting_evidence' && (
        <ProvenanceRail outcome={answer.outcome} documentIndex={documentIndex} />
      )}

      {answer.outcome.kind === 'conflicting_evidence' && (
        <div className="conflict-block">
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

      {answer.verificationReport && answer.verificationReport.droppedClaims.length > 0 && (
        <div className="verification">
          <DroppedClaimsBand
            droppedClaims={answer.verificationReport.droppedClaims}
            isAbstention={answer.outcome.kind === 'insufficient_evidence'}
          />
        </div>
      )}
    </div>
  );
}
