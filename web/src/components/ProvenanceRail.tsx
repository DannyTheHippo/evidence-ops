import { Link } from 'react-router-dom';
import type { AnswerOutcome, Citation } from '../api/client';
import { truncateSha256 } from '../lib/identifiers';
import { formatLocator } from '../lib/locator';
import type { ResolvedVersion } from '../lib/document-index';

export type RailNodeState = 'verified' | 'degraded' | 'neutral';

interface RailNode {
  key: string;
  state: RailNodeState;
  statement: string;
  citations: Citation[];
}

// Visually-hidden text naming each node's state (see the `.sr-only` span below), matching the
// convention `Skeleton.tsx` and `Table.tsx` already use for state that must reach a screen reader
// but has no separate visible label — the dashed/solid line and marker fill carry it visually.
const STATE_LABEL: Record<RailNodeState, string> = {
  verified: 'Verified — grounded in a re-checked citation',
  degraded: 'Degraded — the evidence gate could not verify this answer',
  neutral: 'Unverified',
};

// One rail node per unit of provenance the outcome carries: a claim for `answered`, or the
// outcome itself for `insufficient_evidence`/`conflicting_evidence`, neither of which has claims
// to walk. State mirrors ProvenanceRail's own doc comment table exactly.
function buildRailNodes(outcome: AnswerOutcome): RailNode[] {
  switch (outcome.kind) {
    case 'answered':
      return outcome.claims.map((claim, index) => ({
        key: `claim-${index}`,
        state: claim.citations.length > 0 ? 'verified' : 'neutral',
        statement: claim.statement,
        citations: claim.citations,
      }));
    case 'insufficient_evidence':
      return [
        {
          key: 'outcome',
          // A `reasonCode` marks a model-authored abstention; its absence is the grounding
          // gate's own degraded path (see the doc comment on `AnswerOutcome` in api/client.ts).
          state: outcome.reasonCode ? 'neutral' : 'degraded',
          statement: outcome.reason,
          citations: [],
        },
      ];
    case 'conflicting_evidence':
      return [
        {
          key: 'outcome',
          state: 'neutral',
          statement: `Conflicting values for ${outcome.factKey.entity} — ${outcome.factKey.metric} (${outcome.factKey.period})`,
          citations: [],
        },
      ];
  }
}

interface TraceChipProps {
  citation: Citation;
  resolved?: ResolvedVersion;
}

// `EvidenceChunk._id` is content-addressed — derived from tenant, the version's sha256, an
// ordinal and the locator (migrations/0007-content-addressed-evidence-chunk-ids.ts) — so the
// chunk id here is literally a hash of the verified bytes, not a database surrogate key. The chip
// states that plainly: a truncated hash plus the id it produced, full values on hover. Both halves
// are truncated — a chunk id is itself 64 hex characters, and printing one in full turns every
// chip into a wall of hex that reads the same as its neighbours.
function TraceChip({ citation, resolved }: TraceChipProps) {
  const label = `${truncateSha256(citation.sha256)} · ${truncateSha256(citation.chunkId)}`;
  const title = `sha256 ${citation.sha256} · chunk ${citation.chunkId}`;
  if (resolved) {
    return (
      <Link to={`/documents/${resolved.documentId}`} className="trace-chip mono" title={title}>
        {label}
      </Link>
    );
  }
  return (
    <span className="trace-chip mono" title={title}>
      {label}
    </span>
  );
}

interface ProvenanceRailProps {
  outcome: AnswerOutcome;
  documentIndex: Map<string, ResolvedVersion>;
}

/**
 * The vertical thread of verified facts down the left edge of the answer view. One node per
 * claim for an `answered` outcome, or a single node standing in for the outcome itself when
 * there are no claims to walk (`insufficient_evidence`, `conflicting_evidence`).
 *
 * Node state follows this table exactly — invent nothing beyond it:
 *
 * | Condition                                                                   | State    | Line   |
 * | ---------------------------------------------------------------------------- | -------- | ------ |
 * | An `answered` claim with at least one citation                               | verified | solid  |
 * | `insufficient_evidence` with no `reasonCode` (the grounding gate's own path) | degraded | dashed |
 * | Everything else — a model-authored `insufficient_evidence`, `conflicting_evidence`, or a claim with no citations | neutral | solid |
 *
 * Purely presentational: no fetching, no effects. The caller owns data loading and passes the
 * `documentIndex` resolved by `buildDocumentVersionIndex()`.
 */
export default function ProvenanceRail({ outcome, documentIndex }: ProvenanceRailProps) {
  const nodes = buildRailNodes(outcome);

  return (
    <ul className="rail" role="list">
      {nodes.map((node) => (
        <li key={node.key} className={`rail-node rail-node--${node.state}`}>
          <span className="sr-only">{STATE_LABEL[node.state]}</span>
          <p className="apparatus-claim">{node.statement}</p>
          {node.citations.length > 0 && (
            <ul className="apparatus-citations" role="list">
              {node.citations.map((citation, index) => (
                <li key={index} className="apparatus-citation">
                  <blockquote className="apparatus-quote">{citation.quote}</blockquote>
                  <div className="apparatus-meta">
                    <p className="apparatus-locator mono">{formatLocator(citation.locator)}</p>
                    <TraceChip
                      citation={citation}
                      resolved={documentIndex.get(citation.docVersionId)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
