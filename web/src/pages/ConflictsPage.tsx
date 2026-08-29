import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listConflicts,
  requestConflictResolution,
  type Conflict,
  type ConflictSortField,
  type ConflictStatus,
  type ConflictValue,
  type SortDirection,
} from '../api/client';
import ConflictValueCompare from '../components/ConflictValueCompare';
import { IconAlertTriangle } from '../components/icons';
import QueueList from '../components/QueueList';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import DescriptionList from '../components/ui/DescriptionList';
import EmptyState from '../components/ui/EmptyState';
import FilterBar from '../components/ui/FilterBar';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import SplitView from '../components/ui/SplitView';
import Timestamp from '../components/ui/Timestamp';
import { notify } from '../components/ui/toast';
import { resolveDocumentVersions, type ResolvedVersion } from '../lib/document-index';
import { metricLabel, useMetricLabels } from '../lib/metric-labels';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];

// Field/direction pairs collapsed into one control: the queue column has no header row for
// `SortableHeaderCell` to attach to, the same reasoning `.sort-select` in primitives.css
// documents. `magnitude` is deliberately absent — see `ConflictSortField`'s own comment in
// api/client.ts: every row carries its own `magnitudeUnit`, so ordering by the bare number would
// rank a cap-rate spread against a dollar spread as if on the same scale.
const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'createdAt-desc', label: 'Newest first' },
  { value: 'createdAt-asc', label: 'Oldest first' },
  { value: 'status-asc', label: 'Status (A–Z)' },
  { value: 'status-desc', label: 'Status (Z–A)' },
];

// Declared at module scope: `useUrlState` adopts `defaults` once on mount — see AnswersPage.tsx's
// identical comment. `selected` has no server meaning; it names which queue row the detail pane
// shows, and an id absent from the loaded page (a stale link, or a page change) falls back to the
// first row rather than rendering nothing.
const URL_DEFAULTS: Record<'status' | 'sort' | 'sortDir' | 'skip' | 'selected', string> = {
  status: '',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
  selected: '',
};

function statusTone(status: ConflictStatus): 'caution' | 'verified' | 'neutral' {
  if (status === 'open') return 'caution';
  if (status === 'resolved') return 'verified';
  return 'neutral';
}

// A pane offers at most one primary action, never exactly one: promoting a value the policy did
// not actually recommend — no rule fired, or the recommended source has since been withdrawn —
// would manufacture a recommendation the system did not make.
function isPrimaryValue(conflict: Conflict, value: ConflictValue): boolean {
  return (
    !!conflict.ruleFired &&
    conflict.ruleFired !== 'none' &&
    value.factId === conflict.proposedWinnerFactId &&
    !value.withdrawn
  );
}

function ConflictDetailPane({
  conflict,
  metricLabelText,
  documentIndex,
  resolvingFactId,
  onRequestResolution,
}: {
  conflict: Conflict | null;
  metricLabelText: string;
  documentIndex: Map<string, ResolvedVersion>;
  resolvingFactId: string | null;
  onRequestResolution: (conflict: Conflict, value: ConflictValue) => void;
}) {
  if (!conflict) {
    return (
      <EmptyState
        className="empty-state--inline"
        title="No conflict selected"
        description="Choose a conflict from the queue on the left to review it."
      />
    );
  }

  const detailItems = [
    {
      term: 'Metric',
      description: `${metricLabelText} · ${conflict.factKey.period}`,
    },
    {
      term: 'Spread',
      description: (
        <span className="mono">
          {conflict.magnitude} {conflict.magnitudeUnit}
        </span>
      ),
    },
    { term: 'Created', description: <Timestamp value={conflict.createdAt} /> },
    // Stale and unscorable both gate whether action is even possible, so their reasons render
    // untruncated rather than behind `.cell-truncate`'s hover-only title.
    ...(conflict.stale
      ? [
          {
            term: 'Stale',
            description: <p className="notice notice--warn">{conflict.staleReason}</p>,
          },
        ]
      : []),
    ...(conflict.unscorable
      ? [
          {
            term: 'Unscorable',
            description: <p className="notice notice--warn">{conflict.unscorableReason}</p>,
          },
        ]
      : []),
  ];

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="card-title">{conflict.factKey.entity}</h2>
        <Badge tone={statusTone(conflict.status)}>{conflict.status}</Badge>
      </div>

      <DescriptionList columns={2} items={detailItems} />

      <ConflictValueCompare
        values={conflict.values}
        proposedWinnerFactId={conflict.proposedWinnerFactId}
        ruleFired={conflict.ruleFired}
        explanation={conflict.explanation}
        documentIndex={documentIndex}
        renderAction={
          conflict.status === 'open'
            ? (value) => (
                <Button
                  variant={isPrimaryValue(conflict, value) ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={resolvingFactId === value.factId}
                  onClick={() => onRequestResolution(conflict, value)}
                >
                  {resolvingFactId === value.factId ? 'Requesting…' : 'Request resolution'}
                </Button>
              )
            : undefined
        }
      />
    </div>
  );
}

export default function ConflictsPage() {
  const navigate = useNavigate();
  const metricLabels = useMetricLabels();
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const appliedStatus = urlState.status as ConflictStatus | '';
  const sort = urlState.sort as ConflictSortField;
  const sortDir = urlState.sortDir as SortDirection;
  const skip = Number(urlState.skip);
  const selectedId = urlState.selected;

  // Only this, not the applied filter, drives the `Select` — the filter applies on submit, not on
  // every selection change (AnswersPage.tsx follows the same split).
  const [draftStatus, setDraftStatus] = useState(appliedStatus);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  const [resolvingFactId, setResolvingFactId] = useState<string | null>(null);
  const [pendingResolution, setPendingResolution] = useState<{
    conflict: Conflict;
    value: ConflictValue;
  } | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // Blocks a double submit between the confirm click and the re-render that disables
  // `ConfirmDialog`'s own buttons, matching ApprovalsPage.tsx's `submitInFlightRef`.
  const resolveInFlightRef = useRef(false);

  useEffect(() => {
    listConflicts({
      skip,
      limit: PAGE_SIZE,
      status: appliedStatus === '' ? undefined : appliedStatus,
      sort,
      sortDir,
    })
      .then(({ docs, count: total }) => {
        setConflicts(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load conflicts');
      });
  }, [skip, appliedStatus, sort, sortDir]);

  // Resolves value document titles once there is something to resolve. Failure here must not
  // affect conflict rendering — see document-index.ts.
  useEffect(() => {
    if (!conflicts || conflicts.length === 0) return;
    let cancelled = false;

    resolveDocumentVersions(
      conflicts.flatMap((conflict) => conflict.values.map((value) => value.documentVersionId)),
    )
      .then((index) => {
        if (!cancelled) setDocumentIndex(index);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [conflicts]);

  function handleApply() {
    setUrlState({ status: draftStatus, skip: URL_DEFAULTS.skip });
  }

  function handleClear() {
    setDraftStatus('');
    setUrlState({ status: '', skip: URL_DEFAULTS.skip });
  }

  function handleSortChange(value: string) {
    const [field, direction] = value.split('-');
    setUrlState({ sort: field, sortDir: direction, skip: URL_DEFAULTS.skip });
  }

  function handleSelect(id: string) {
    setUrlState({ selected: id });
  }

  function openResolveDialog(conflict: Conflict, value: ConflictValue) {
    setPendingResolution({ conflict, value });
    setResolveError(null);
  }

  function closeResolveDialog() {
    setPendingResolution(null);
    setResolveError(null);
  }

  async function confirmResolve() {
    if (!pendingResolution || resolveInFlightRef.current) return;
    resolveInFlightRef.current = true;
    setResolvingFactId(pendingResolution.value.factId);
    setResolveError(null);
    try {
      const run = await requestConflictResolution(
        pendingResolution.conflict.id,
        pendingResolution.value.factId,
      );
      notify('success', 'Resolution requested — a workflow run started and now needs approval.');
      setPendingResolution(null);
      await navigate(`/workflow-runs/${run.id}`);
    } catch (err: unknown) {
      setResolveError(err instanceof Error ? err.message : 'Failed to request resolution');
    } finally {
      setResolvingFactId(null);
      resolveInFlightRef.current = false;
    }
  }

  const hasFilter = appliedStatus !== '';
  const sortKey = `${sort}-${sortDir}`;
  const selectedConflict =
    conflicts?.find((conflict) => conflict.id === selectedId) ?? conflicts?.[0] ?? null;

  let status: RecordListStatus;
  if (conflicts === null) {
    status = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading conflicts…' };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Review"
      title="Conflicts"
      description="Facts extracted from the evidence corpus that disagree."
      filters={
        <>
          <FilterBar onApply={handleApply} onClear={handleClear} hasFilter={hasFilter}>
            <Select
              label="Status"
              options={STATUS_OPTIONS}
              value={draftStatus}
              onChange={(value) => setDraftStatus(value as ConflictStatus | '')}
            />
          </FilterBar>
          <div className="control-row">
            <div className="sort-select">
              <Select
                label="Sort"
                options={SORT_OPTIONS}
                value={sortKey}
                onChange={handleSortChange}
              />
            </div>
          </div>
        </>
      }
      error={error ?? undefined}
      status={status}
      footer={
        conflicts && (
          <Pager
            count={count}
            skip={skip}
            pageSize={PAGE_SIZE}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
          />
        )
      }
    >
      {conflicts && conflicts.length === 0 && !hasFilter && (
        <EmptyState
          className="empty-state--zero"
          icon={<IconAlertTriangle size={24} />}
          title="No conflicts"
          description="The evidence corpus currently agrees with itself — every extracted fact has a single value."
        />
      )}

      {conflicts && conflicts.length === 0 && hasFilter && (
        <EmptyState
          icon={<IconAlertTriangle size={24} />}
          title="No conflicts match this filter"
          description="Clear or adjust the status filter above."
          action={
            <Button variant="secondary" onClick={handleClear}>
              Show all
            </Button>
          }
        />
      )}

      {conflicts && conflicts.length > 0 && (
        <SplitView
          ratio="queue"
          primaryLabel="Conflicts queue"
          secondaryLabel="Conflict detail"
          primary={
            <QueueList
              items={conflicts}
              selectedId={selectedConflict?.id ?? null}
              onSelect={handleSelect}
              ariaLabel="Conflicting facts extracted from the evidence corpus"
              renderItem={(conflict) => ({
                identity: (
                  <>
                    <h2 className="card-title cell-truncate">{conflict.factKey.entity}</h2>
                    <Badge tone={statusTone(conflict.status)}>{conflict.status}</Badge>
                  </>
                ),
                quantifier: (
                  <>
                    <span>{metricLabel(conflict.factKey.metric, metricLabels)}</span> ·{' '}
                    {conflict.factKey.period} ·{' '}
                    <span className="mono">
                      spread {conflict.magnitude} {conflict.magnitudeUnit}
                    </span>
                  </>
                ),
                age: (
                  <>
                    <Timestamp value={conflict.createdAt} />
                    {conflict.stale && <Badge tone="caution">Stale</Badge>}
                  </>
                ),
              })}
            />
          }
          secondary={
            <ConflictDetailPane
              conflict={selectedConflict}
              metricLabelText={
                selectedConflict ? metricLabel(selectedConflict.factKey.metric, metricLabels) : ''
              }
              documentIndex={documentIndex}
              resolvingFactId={resolvingFactId}
              onRequestResolution={openResolveDialog}
            />
          }
        />
      )}

      <ConfirmDialog
        open={pendingResolution !== null}
        onClose={closeResolveDialog}
        title="Request resolution"
        body={
          pendingResolution
            ? `Request resolution using ${pendingResolution.value.value} ${pendingResolution.value.unit} as the winning value? This starts a workflow run that needs approval.`
            : ''
        }
        confirmLabel="Request resolution"
        busy={resolvingFactId !== null}
        error={resolveError ?? undefined}
        onConfirm={() => void confirmResolve()}
      />
    </RecordListPage>
  );
}
