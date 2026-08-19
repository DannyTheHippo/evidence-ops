import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listConflicts,
  requestConflictResolution,
  type Conflict,
  type ConflictStatus,
} from '../api/client';
import { IconAlertTriangle } from '../components/icons';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
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
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Review</span>
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

      {!conflicts && !error && <Skeleton label="Loading conflicts…" />}

      {conflicts && conflicts.length === 0 && hasFilter && (
        <EmptyState
          icon={<IconAlertTriangle size={24} />}
          title="No conflicts match this filter"
          description="Clear or adjust the status filter above."
        />
      )}

      {conflicts && conflicts.length === 0 && !hasFilter && (
        <EmptyState
          icon={<IconAlertTriangle size={24} />}
          title="No conflicts"
          description="The evidence corpus currently agrees with itself — every extracted fact has a single value."
        />
      )}

      {conflicts && conflicts.length > 0 && (
        <ul
          className="actionable-list"
          aria-label="Conflicting facts extracted from the evidence corpus, with the survivorship policy's recommended value where it has one."
        >
          {conflicts.map((conflict) => (
            <li key={conflict.id} className="card">
              <div className="card-head">
                <h2 className="card-title">{conflict.factKey.entity}</h2>
                <Badge tone={statusTone(conflict.status)}>{conflict.status}</Badge>
              </div>
              <p className="cell-sub">
                <span>{conflict.factKey.metric}</span> · {conflict.factKey.period} ·{' '}
                <span className="mono">spread {conflict.magnitude}</span>
              </p>

              {conflict.unscorable && (
                <p className="cell-sub">
                  <Badge tone="rejected">Unscorable</Badge>{' '}
                  <span className="cell-truncate" title={conflict.unscorableReason}>
                    {conflict.unscorableReason}
                  </span>
                </p>
              )}
              {conflict.ruleFired === 'none' && (
                <p className="cell-sub">
                  <span
                    className="cell-truncate"
                    title={`Policy has no recommendation for this conflict — ${conflict.explanation}`}
                  >
                    Policy has no recommendation for this conflict — {conflict.explanation}
                  </span>
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
                          <Badge tone="info">recommended · {conflict.ruleFired}</Badge>
                          <p className="cell-sub">
                            <span className="cell-truncate" title={conflict.explanation}>
                              {conflict.explanation}
                            </span>
                          </p>
                        </>
                      )}
                      {conflict.status === 'open' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={resolvingFactId === value.factId}
                          onClick={() => void handleResolve(conflict.id, value.factId)}
                        >
                          {resolvingFactId === value.factId ? 'Requesting…' : 'Request resolution'}
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
            </li>
          ))}
        </ul>
      )}

      {conflicts && <Pager count={count} skip={skip} pageSize={PAGE_SIZE} onSkipChange={setSkip} />}
    </div>
  );
}
