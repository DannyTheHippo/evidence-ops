import type { Answer, ConflictingValue, ConflictValue, DroppedClaim, Locator } from '../api/client';
import type { ResolvedVersion } from '../lib/document-index';
import ConflictValueCompare from './ConflictValueCompare';
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
// claim. Renders nothing once there is nothing dropped to show, which lets a caller pass the
// report's `droppedClaims` (or an empty array when there is no report at all) unconditionally.
function DroppedClaimsBand({ droppedClaims, isAbstention }: DroppedClaimsBandProps) {
  if (droppedClaims.length === 0) return null;

  // The grounding gate's own degraded `insufficient_evidence` drops every asserted claim, which
  // would otherwise make an "N claims dropped" framing read as a partial failure among a longer
  // list rather than the reason the model abstained.
  const headline = isAbstention
    ? 'No claim passed the grounding check — this is why the model abstained.'
    : `${droppedClaims.length} claim${droppedClaims.length === 1 ? '' : 's'} dropped by the grounding check`;

  return (
    <section className="verification-integrity">
      <h3 className="dropped-claims-headline">{headline}</h3>
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
    </section>
  );
}

// `AnswerOutcome`'s `conflicting_evidence` carries only `value`/`unit`/`sourceChunkId` per
// competing value — `conflictChunkIndex` (built by the caller from `listConflicts()`, capped at
// its own page size) is what resolves a chunk to the document version and locator
// `ConflictValueCompare` needs to render a source passage and a workbench link. A chunk absent
// from that index — past the cap, or a conflict the index hasn't loaded yet — stays a value with
// no source to point at, not an error; it renders in `unresolved` instead of `resolved`.
function splitConflictValues(
  values: ConflictingValue[],
  conflictChunkIndex: Map<string, ConflictChunkResolution>,
  documentIndex: Map<string, ResolvedVersion>,
): { resolved: ConflictValue[]; unresolved: ConflictingValue[] } {
  const resolved: ConflictValue[] = [];
  const unresolved: ConflictingValue[] = [];
  for (const value of values) {
    const chunkResolution = conflictChunkIndex.get(value.sourceChunkId);
    if (!chunkResolution) {
      unresolved.push(value);
      continue;
    }
    resolved.push({
      // Neither the outcome nor `conflictChunkIndex` carries the real `ExtractedFact` id this
      // value came from — the source chunk id is unique per value here and serves the same role
      // `ConflictValueCompare` needs one for: a list key. There is no recommendation to compare
      // it against, since `proposedWinnerFactId` is never passed below.
      factId: value.sourceChunkId,
      value: value.value,
      unit: value.unit,
      sourceChunkId: value.sourceChunkId,
      documentVersionId: chunkResolution.documentVersionId,
      locator: chunkResolution.locator,
      withdrawn: documentIndex.get(chunkResolution.documentVersionId)?.withdrawn ?? false,
    });
  }
  return { resolved, unresolved };
}

/**
 * The completed-answer presentation shared by AskPage's live view and AnswerDetailPage's
 * historical view: the verification ledger's retrieval funnel, the provenance rail for
 * `answered`/`insufficient_evidence`, the value-compare markup for `conflicting_evidence` (the
 * rail's node for that outcome states only the fact key, not the compared values or their
 * resolved sources), and the dropped-claims integrity section. Renders nothing for an answer that
 * isn't `completed` or carries no outcome yet — the caller owns showing that state itself.
 *
 * Purely presentational: no fetching, no effects. The caller resolves and passes `documentIndex`
 * (`buildDocumentVersionIndex()`) and `conflictChunkIndex`.
 */
export default function AnswerView({ answer, documentIndex, conflictChunkIndex }: AnswerViewProps) {
  if (answer.runStatus !== 'completed' || !answer.outcome) return null;

  const withdrawnDocVersionIds = new Set(answer.withdrawnCitedDocVersionIds);
  const conflictSplit =
    answer.outcome.kind === 'conflicting_evidence'
      ? splitConflictValues(answer.outcome.values, conflictChunkIndex, documentIndex)
      : null;

  return (
    <div className="answer-outcome">
      <VerificationLedger
        outcome={answer.outcome}
        verificationReport={answer.verificationReport}
        retrievedChunkCount={answer.retrievedChunkCount}
        documentIndex={documentIndex}
      />

      {answer.outcome.kind !== 'conflicting_evidence' && (
        <ProvenanceRail
          outcome={answer.outcome}
          documentIndex={documentIndex}
          withdrawnDocVersionIds={withdrawnDocVersionIds}
        />
      )}

      {conflictSplit && (
        <div className="conflict-block">
          <ConflictValueCompare values={conflictSplit.resolved} documentIndex={documentIndex} />
          {conflictSplit.unresolved.length > 0 && (
            <ul className="value-compare" aria-label="Competing values with no resolved source">
              {conflictSplit.unresolved.map((value, valueIndex) => (
                <li key={valueIndex} className="value-compare-item">
                  <span className="mono">
                    {value.value} {value.unit}
                  </span>
                  <span className="cell-sub">{value.sourceChunkId}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <DroppedClaimsBand
        droppedClaims={answer.verificationReport?.droppedClaims ?? []}
        isAbstention={answer.outcome.kind === 'insufficient_evidence'}
      />
    </div>
  );
}
