import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listConflicts,
  requestConflictResolution,
  type Conflict,
  type ConflictStatus,
} from '../api/client';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableHeaderCell } from '../components/ui/Table';
import { notify } from '../components/ui/toast';
import { buildDocumentVersionIndex, type ResolvedVersion } from '../lib/document-index';
import { truncateSha256 } from '../lib/identifiers';
import { formatLocator } from '../lib/locator';

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];

function statusTone(status: Conflict['status']): 'caution' | 'verified' | 'neutral' {
  if (status === 'open') return 'caution';
  if (status === 'resolved') return 'verified';
  return 'neutral';
}

export default function ConflictsPage() {
  const navigate = useNavigate();
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  const [resolvingFactId, setResolvingFactId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState(0);
  const [status, setStatus] = useState<ConflictStatus | ''>('');
  // Only this, not `status` itself, drives the fetch — the filter applies on submit, not on
  // every selection change (AnswersPage.tsx follows the same split).
  const [appliedStatus, setAppliedStatus] = useState<ConflictStatus | ''>('');

  useEffect(() => {
    listConflicts({
      skip,
      limit: PAGE_SIZE,
      status: appliedStatus === '' ? undefined : appliedStatus,
    })
      .then(({ docs, count: total }) => {
        setConflicts(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load conflicts');
      });
  }, [skip, appliedStatus]);

  function handleFilter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSkip(0);
    setAppliedStatus(status);
  }

  const hasFilter = appliedStatus !== '';

  // Resolves value document titles once there is something to resolve. Failure here must not
  // affect conflict rendering — see document-index.ts.
  useEffect(() => {
    if (!conflicts || conflicts.length === 0) return;
    let cancelled = false;

    buildDocumentVersionIndex()
      .then((index) => {
        if (!cancelled) setDocumentIndex(index);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [conflicts]);

  async function handleResolve(conflictId: string, factId: string) {
    setResolvingFactId(factId);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[factId];
      return next;
    });
    try {
      const run = await requestConflictResolution(conflictId, factId);
      notify('success', 'Resolution requested — a workflow run started and now needs approval.');
      await navigate(`/workflow-runs/${run.id}`);
    } catch (err: unknown) {
      setRowErrors((current) => ({
        ...current,
        [factId]: err instanceof Error ? err.message : 'Failed to request resolution',
      }));
    } finally {
      setResolvingFactId(null);
    }
  }

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Evidence</span>
          <h1 className="page-title">Conflicts</h1>
          <p className="page-sub">Facts extracted from the evidence corpus that disagree.</p>
        </div>
      </div>

      <form onSubmit={handleFilter} className="control-row">
        <Select
          label="Status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(value) => setStatus(value as ConflictStatus | '')}
        />
        <Button type="submit" variant="primary">
          Apply filters
        </Button>
      </form>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {!conflicts && !error && <Skeleton label="Loading…" />}

      {conflicts && conflicts.length === 0 && hasFilter && (
        <EmptyState
          title="No conflicts match this filter."
          description="Clear or adjust the status filter above."
        />
      )}

      {conflicts && conflicts.length === 0 && !hasFilter && (
        <EmptyState
          title="No conflicts"
          description="The evidence corpus currently agrees with itself — every extracted fact has a single value."
        />
      )}

      {conflicts && conflicts.length > 0 && (
        <section className="panel">
          <Table caption="Conflicting facts extracted from the evidence corpus, with the survivorship policy's recommended value where it has one.">
            <thead>
              <tr>
                <TableHeaderCell>Entity</TableHeaderCell>
                <TableHeaderCell>Metric</TableHeaderCell>
                <TableHeaderCell>Period</TableHeaderCell>
                <TableHeaderCell>Magnitude</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Values</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((conflict) => (
                <tr key={conflict.id}>
                  <td>{conflict.factKey.entity}</td>
                  <td className="cell-sub">{conflict.factKey.metric}</td>
                  <td className="cell-sub">{conflict.factKey.period}</td>
                  <td className="num">{conflict.magnitude}</td>
                  <td>
                    <Badge tone={statusTone(conflict.status)}>{conflict.status}</Badge>
                  </td>
                  <td>
                    {conflict.ruleFired === 'none' && (
                      <p className="cell-sub">
                        Policy has no recommendation for this conflict — {conflict.explanation}
                      </p>
                    )}
                    <ul className="value-compare">
                      {conflict.values.map((value) => {
                        const resolved = documentIndex.get(value.documentVersionId);
                        const title = resolved?.documentTitle ?? 'Unknown document';
                        const isRecommended = value.factId === conflict.proposedWinnerFactId;
                        return (
                          <li
                            key={value.factId}
                            className={
                              isRecommended
                                ? 'value-compare-item value-compare-item--recommended'
                                : 'value-compare-item'
                            }
                          >
                            <span className="mono">
                              {value.value} {value.unit}
                            </span>
                            <span className="cell-sub">
                              {title} — {formatLocator(value.locator)}
                            </span>
                            <span className="trace-chip mono" title={value.sourceChunkId}>
                              {truncateSha256(value.sourceChunkId)}
                            </span>
                            {isRecommended && (
                              <>
                                <Badge tone="info">Recommended · {conflict.ruleFired}</Badge>
                                <p className="cell-sub">{conflict.explanation}</p>
                              </>
                            )}
                            {conflict.status === 'open' && (
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={resolvingFactId === value.factId}
                                onClick={() => void handleResolve(conflict.id, value.factId)}
                              >
                                {resolvingFactId === value.factId
                                  ? 'Requesting…'
                                  : 'Request resolution'}
                              </Button>
                            )}
                            {rowErrors[value.factId] && (
                              <p className="error" role="alert">
                                {rowErrors[value.factId]}
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {conflicts && <Pager count={count} skip={skip} pageSize={PAGE_SIZE} onSkipChange={setSkip} />}
    </div>
  );
}
