import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listLedgerFacts,
  type LedgerCell,
  type LedgerCellState,
  type LedgerFact,
} from '../../api/client';
import Badge, { type BadgeTone } from '../../components/ui/Badge';
import DescriptionList from '../../components/ui/DescriptionList';
import LinkButton from '../../components/ui/LinkButton';
import Skeleton from '../../components/ui/Skeleton';
import Timestamp from '../../components/ui/Timestamp';
import { workbenchHref } from '../../lib/citation-link';
import { resolveDocumentVersions, type ResolvedVersion } from '../../lib/document-index';
import { truncateSha256 } from '../../lib/identifiers';
import { formatLocator } from '../../lib/locator';

const STATE_TONE: Record<LedgerCellState, BadgeTone> = {
  single: 'verified',
  adjudicated: 'info',
  conflicted: 'caution',
  unknown: 'neutral',
};

interface LedgerCellDetailProps {
  cell: LedgerCell;
  measureLabel: string;
}

/**
 * The drill-down behind one ledger cell: the resolved value (when there is one), the facts it
 * rests on, and — for an adjudicated cell — the decision that settled it. An adjudicated cell
 * with `winnerWithdrawn: true` still renders its decision as-is: the human decision stands even
 * though the winning fact's document version has since been withdrawn, so this never falls back
 * to treating the cell as undecided.
 */
export default function LedgerCellDetail({ cell, measureLabel }: LedgerCellDetailProps) {
  const [facts, setFacts] = useState<LedgerFact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());

  useEffect(() => {
    let cancelled = false;

    listLedgerFacts({ entity: cell.entity, measure: cell.measure, period: cell.period })
      .then(({ docs }) => {
        if (cancelled) return;
        setFacts(docs);
        setError(null);
        resolveDocumentVersions(docs.map((fact) => fact.citation.documentVersionId))
          .then((index) => {
            if (!cancelled) setDocumentIndex(index);
          })
          .catch(() => {});
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load facts');
      });

    return () => {
      cancelled = true;
    };
  }, [cell.entity, cell.measure, cell.period]);

  const detailItems = [
    { term: 'State', description: <Badge tone={STATE_TONE[cell.state]}>{cell.state}</Badge> },
    {
      term: 'Value',
      description: cell.value ? (
        <span className="mono" title={String(cell.value.canonicalAmount)}>
          {cell.value.amount} {cell.value.unit}
        </span>
      ) : (
        '—'
      ),
    },
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
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          {cell.entity} · {measureLabel}
          {cell.period ? ` · ${cell.period}` : ''}
        </h2>
        <Badge tone={STATE_TONE[cell.state]}>{cell.state}</Badge>
      </div>

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

      {cell.state === 'conflicted' && (
        <LinkButton
          to={`/adjudication?kind=conflicts&selected=${cell.conflictId}`}
          variant="secondary"
          size="sm"
        >
          Adjudicate
        </LinkButton>
      )}

      {facts === null && !error && <Skeleton label="Loading facts…" />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {facts && facts.length > 0 && (
        <ul className="citations">
          {facts.map((fact) => (
            <li key={fact.id} className="citation">
              <span className="mono">
                {fact.value.amount} {fact.value.unit}
              </span>
              <Badge tone={fact.measureStatus === 'confirmed' ? 'verified' : 'caution'}>
                {fact.measureStatus}
              </Badge>
              <blockquote className="citation-quote">{fact.citation.quote}</blockquote>
              <span className="trace-chip mono">{formatLocator(fact.citation.locator)}</span>
              <Link
                className="trace-chip mono"
                to={workbenchHref({
                  documentId: fact.citation.documentId,
                  versionId: fact.citation.documentVersionId,
                })}
                title={fact.citation.sha256}
              >
                {documentIndex.get(fact.citation.documentVersionId)?.documentTitle ??
                  truncateSha256(fact.citation.sha256)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
