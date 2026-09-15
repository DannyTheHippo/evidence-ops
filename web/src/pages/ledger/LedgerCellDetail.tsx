import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listLedgerFacts,
  type LedgerCell,
  type LedgerCellState,
  type LedgerFact,
} from '../../api/client';
import Alert from '../../components/ui/Alert';
import Badge, { type BadgeTone } from '../../components/ui/Badge';
import CopyButton from '../../components/ui/CopyButton';
import DescriptionList from '../../components/ui/DescriptionList';
import EmptyState from '../../components/ui/EmptyState';
import LinkButton from '../../components/ui/LinkButton';
import Skeleton from '../../components/ui/Skeleton';
import Timestamp from '../../components/ui/Timestamp';
import { workbenchHref } from '../../lib/citation-link';
import { resolveDocumentVersions, type ResolvedVersion } from '../../lib/document-index';
import { formatCanonicalValue, formatMeasureValue } from '../../lib/format-value';
import { truncateSha256 } from '../../lib/identifiers';
import { formatLocator } from '../../lib/locator';
import { useAbortableEffect } from '../../lib/use-latest';

const STATE_TONE: Record<LedgerCellState, BadgeTone> = {
  single: 'verified',
  adjudicated: 'info',
  conflicted: 'caution',
  unknown: 'neutral',
};

interface LedgerCellDetailProps {
  cell: LedgerCell;
  /** The cell's measure's canonical unit — the caller resolves it from the confirmed-measure
   * vocabulary it already loaded. Omitted, the canonical value row renders unitless. */
  canonicalUnit?: string;
}

/**
 * The drill-down behind one ledger cell: the resolved value (when there is one), the facts it
 * rests on, and — for an adjudicated cell — the decision that settled it. Rendered as the body of
 * the ledger's `Drawer`, which names the cell in its own title, so this carries no heading of its
 * own. An adjudicated cell with `winnerWithdrawn: true` still renders its decision as-is: the
 * human decision stands even though the winning fact's document version has since been withdrawn,
 * so this never falls back to treating the cell as undecided.
 */
export default function LedgerCellDetail({ cell, canonicalUnit }: LedgerCellDetailProps) {
  const [facts, setFacts] = useState<LedgerFact[] | null>(null);
  const [factsCount, setFactsCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());

  useAbortableEffect(
    (isCurrent) => {
      listLedgerFacts({
        entity: cell.entity,
        measure: cell.measure,
        period: cell.period,
        limit: 100,
      })
        .then(({ docs, count }) => {
          if (!isCurrent()) return;
          setFacts(docs);
          setFactsCount(count);
          setError(null);
          // Best-effort titles for the citation links: a failed lookup leaves each link on its
          // truncated checksum rather than surfacing an error over the facts themselves.
          resolveDocumentVersions(docs.map((fact) => fact.citation.documentVersionId))
            .then((index) => {
              if (isCurrent()) setDocumentIndex(index);
            })
            .catch(() => {});
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setError(err instanceof Error ? err.message : 'Failed to load facts');
        });
    },
    [cell.entity, cell.measure, cell.period],
  );

  const canonicalValue = cell.value ? formatCanonicalValue(cell.value, canonicalUnit) : undefined;

  const detailItems = [
    { term: 'State', description: <Badge tone={STATE_TONE[cell.state]}>{cell.state}</Badge> },
    {
      term: 'Value',
      description: cell.value ? (
        <span className="mono">{formatMeasureValue(cell.value)}</span>
      ) : (
        '—'
      ),
    },
    ...(canonicalValue !== undefined
      ? [{ term: 'Canonical value', description: <span className="mono">{canonicalValue}</span> }]
      : []),
    { term: 'Facts', description: cell.factIds.length },
  ];

  const decisionItems = cell.decision
    ? [
        { term: 'Outcome', description: cell.decision.outcome },
        { term: 'Decided by', description: cell.decision.decidedBy ?? '—' },
        { term: 'Reason', description: cell.decision.reason ?? '—' },
        { term: 'Resolved at', description: <Timestamp value={cell.decision.resolvedAt} /> },
        { term: 'Rule fired', description: cell.decision.ruleFired ?? '—' },
        {
          term: 'Followed proposal',
          description:
            cell.decision.followedProposal === undefined
              ? '—'
              : cell.decision.followedProposal
                ? 'Yes'
                : 'No',
        },
      ]
    : [];

  return (
    <>
      <Badge tone={STATE_TONE[cell.state]}>{cell.state}</Badge>

      <DescriptionList columns={2} items={detailItems} />

      {cell.decision && (
        <>
          <div className="section-head">
            <h2 className="card-title">Decision</h2>
            {/* The decision stands even though the document version behind the winning fact has
                since been withdrawn — this flags that fact instead of hiding or overriding the
                decision it does not invalidate. */}
            {cell.winnerWithdrawn && <Badge tone="caution">Winning source withdrawn</Badge>}
          </div>
          <DescriptionList columns={2} items={decisionItems} />
          <LinkButton
            to={`/adjudication?kind=conflicts&selected=${cell.conflictId}`}
            variant="secondary"
            size="sm"
          >
            Open in Adjudication
          </LinkButton>
        </>
      )}

      {cell.state === 'conflicted' &&
        (cell.conflictId ? (
          <LinkButton
            to={`/adjudication?kind=conflicts&selected=${cell.conflictId}`}
            variant="secondary"
            size="sm"
          >
            Adjudicate
          </LinkButton>
        ) : (
          <p className="cell-sub">This disagreement has not been recorded as a conflict yet.</p>
        ))}

      {facts === null && !error && <Skeleton label="Loading facts…" />}
      {error && <Alert tone="rejected">{error}</Alert>}

      {facts && facts.length === 0 && (
        <EmptyState className="empty-state--inline" title="No facts recorded for this cell" />
      )}

      {facts && facts.length > 0 && (
        <>
          <ul className="citations">
            {facts.map((fact) => (
              <li key={fact.id} className="citation">
                <span className="mono">{formatMeasureValue(fact.value)}</span>
                <Badge tone={fact.measureStatus === 'confirmed' ? 'verified' : 'caution'}>
                  {fact.measureStatus}
                </Badge>
                {fact.citation.withdrawn && <Badge tone="caution">Source withdrawn</Badge>}
                <blockquote className="citation-quote">{fact.citation.quote}</blockquote>
                <span className="trace-chip mono">{formatLocator(fact.citation.locator)}</span>
                <Link
                  className="trace-chip mono"
                  to={workbenchHref({
                    documentId: fact.citation.documentId,
                    versionId: fact.citation.documentVersionId,
                  })}
                >
                  {documentIndex.get(fact.citation.documentVersionId)?.documentTitle ??
                    truncateSha256(fact.citation.sha256)}
                </Link>
                {/* The full checksum, reachable from the keyboard: the link shows a title or a
                    truncation, so this is the only path to the whole value. */}
                <CopyButton text={fact.citation.sha256} label="Copy checksum" iconOnly />
              </li>
            ))}
          </ul>
          {facts.length < factsCount && (
            <p className="cell-sub">
              Showing {facts.length} of {factsCount} facts.
            </p>
          )}
        </>
      )}
    </>
  );
}
