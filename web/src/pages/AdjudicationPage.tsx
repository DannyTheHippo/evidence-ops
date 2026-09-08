import { useEffect, useState } from 'react';
import {
  listApprovals,
  listConflicts,
  type Approval,
  type ApprovalSortField,
  type ApprovalState,
  type Conflict,
  type ConflictStatus,
  type SortDirection,
} from '../api/client';
import { IconAlertTriangle, IconCheck } from '../components/icons';
import QueueList from '../components/QueueList';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import FilterBar from '../components/ui/FilterBar';
import Pager from '../components/ui/Pager';
import SegmentedControl from '../components/ui/SegmentedControl';
import Select from '../components/ui/Select';
import SplitView from '../components/ui/SplitView';
import Timestamp from '../components/ui/Timestamp';
import { approvalStateTone, conflictStatusTone } from '../lib/adjudication-status';
import { resolveDocumentVersions, type ResolvedVersion } from '../lib/document-index';
import { metricLabel, useMetricLabels } from '../lib/metric-labels';
import { useSession } from '../lib/use-session';
import { useUrlState } from '../lib/use-url-state';
import ConflictCase from './adjudication/ConflictCase';
import DecisionCase from './adjudication/DecisionCase';

const PAGE_SIZE = 20;

type AdjudicationKind = 'conflicts' | 'decisions';

const KIND_OPTIONS: { value: AdjudicationKind; label: string }[] = [
  { value: 'conflicts', label: 'Conflicts' },
  { value: 'decisions', label: 'Decisions' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];

// No "All states" entry — the server substitutes `pending` when the param is omitted
// (`approvals.service.ts`'s `peekPending`), so omitting the filter never means "every state".
const STATE_OPTIONS: { value: ApprovalState; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'timed_out', label: 'Timed out' },
];

// Conflicts only sort on createdAt here (the queue column has no header row for
// `SortableHeaderCell`, matching every other list page's `.sort-select`) — the fetch below always
// sends `sort: 'createdAt'` for this kind, so the control only needs to carry direction.
const CONFLICT_SORT_OPTIONS: { value: SortDirection; label: string }[] = [
  { value: 'desc', label: 'Newest first' },
  { value: 'asc', label: 'Oldest first' },
];

const DECISION_SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'createdAt-desc', label: 'Newest first' },
  { value: 'createdAt-asc', label: 'Oldest first' },
  { value: 'state-asc', label: 'State (A–Z)' },
  { value: 'state-desc', label: 'State (Z–A)' },
  { value: 'decidedAt-desc', label: 'Recently decided' },
  { value: 'decidedAt-asc', label: 'Decided (oldest)' },
];

// Declared at module scope, matching every other list page's own `URL_DEFAULTS` — `useUrlState`
// adopts this once on mount. `status` and `state` are independent filters, one per kind, so
// switching `kind` never clobbers the other's applied value. `selected` has no server meaning; it
// names which queue row the detail pane shows, and an id absent from the loaded page (a stale
// link, or a page/kind change) falls back to the first row rather than rendering nothing.
const URL_DEFAULTS: Record<
  'kind' | 'status' | 'state' | 'sort' | 'sortDir' | 'skip' | 'selected',
  string
> = {
  kind: 'decisions',
  status: '',
  state: 'pending',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
  selected: '',
};

/** The value `conflict.proposedWinnerFactId` points at, formatted for display — `'none'` when the
 *  id names no value in `conflict.values` (data drift) or the policy proposed none. */
function proposalLabel(conflict: Conflict | undefined): string {
  const winner = conflict?.values.find((value) => value.factId === conflict.proposedWinnerFactId);
  return winner ? `${winner.value} ${winner.unit}` : conflict ? 'none' : '—';
}

/**
 * The merged adjudication queue: every open disagreement in the record and every human decision
 * that settles one, in a single review surface. A conflict row and a decision row both carry the
 * proposal, the rule that fired, the decision and the reason — `Conflict.resolution` and
 * `listConflicts({ ids })` (Phase 3B / 4.14) mean the decisions kind needs no second query per row
 * to join a conflict onto its approval.
 */
export default function AdjudicationPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const kind = urlState.kind as AdjudicationKind;
  const appliedStatus = urlState.status as ConflictStatus | '';
  const appliedState = urlState.state as ApprovalState;
  const sort = urlState.sort;
  const sortDir = urlState.sortDir as SortDirection;
  const skip = Number(urlState.skip);
  const selectedId = urlState.selected;

  // Only these, not the `Select`s' own values, drive the fetch — the filter applies on submit,
  // not on every selection change (every other list page follows the same split).
  const [draftStatus, setDraftStatus] = useState(appliedStatus);
  const [draftState, setDraftState] = useState(appliedState);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [conflictsById, setConflictsById] = useState<Map<string, Conflict>>(new Map());
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  const metricLabels = useMetricLabels();
  const session = useSession();
  // Fails CLOSED on the still-loading probe too, not just anon/error — a member (or a session
  // that hasn't resolved yet) never sees the decide controls flash in before the check lands.
  const canDecide = session.status === 'authed' && session.me.role === 'admin';
  const sessionResolved = session.status !== 'loading';

  useEffect(() => {
    let cancelled = false;

    if (kind === 'conflicts') {
      listConflicts({
        skip,
        limit: PAGE_SIZE,
        status: appliedStatus === '' ? undefined : appliedStatus,
        sort: 'createdAt',
        sortDir,
      })
        .then(({ docs, count: total }) => {
          if (cancelled) return;
          setConflicts(docs);
          setCount(total);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Failed to load conflicts');
        });
    } else {
      listApprovals({
        skip,
        limit: PAGE_SIZE,
        state: appliedState,
        sort: sort as ApprovalSortField,
        sortDir,
      })
        .then(({ docs, count: total }) => {
          if (cancelled) return;
          setApprovals(docs);
          setCount(total);
          setError(null);

          // A conflict-resolution approval carries no proposal of its own — `subject.entityId`
          // is the conflict id, and the proposal (winner, rule, decision) lives on the conflict.
          // `ids` fetches every referenced conflict exactly, not a recency-bounded page.
          const conflictIds = [
            ...new Set(
              docs
                .filter((approval) => approval.subject.entityType === 'Conflict')
                .map((approval) => approval.subject.entityId),
            ),
          ];
          if (conflictIds.length === 0) {
            setConflictsById(new Map());
            return;
          }
          listConflicts({ ids: conflictIds })
            .then((result) => {
              if (!cancelled) {
                setConflictsById(new Map(result.docs.map((conflict) => [conflict.id, conflict])));
              }
            })
            .catch(() => {});
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Failed to load approvals');
        });
    }

    return () => {
      cancelled = true;
    };
  }, [kind, skip, appliedStatus, appliedState, sort, sortDir]);

  // Resolves value document titles once there is something to resolve. Failure here must not
  // affect conflict rendering — see document-index.ts.
  useEffect(() => {
    const source = kind === 'conflicts' ? (conflicts ?? []) : [...conflictsById.values()];
    if (source.length === 0) return;
    let cancelled = false;

    resolveDocumentVersions(
      source.flatMap((conflict) => conflict.values.map((value) => value.documentVersionId)),
    )
      .then((index) => {
        if (!cancelled) setDocumentIndex(index);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [kind, conflicts, conflictsById]);

  function handleKindChange(next: AdjudicationKind) {
    setUrlState({ kind: next, skip: URL_DEFAULTS.skip, selected: URL_DEFAULTS.selected });
  }

  function handleApplyStatus() {
    setUrlState({ status: draftStatus, skip: URL_DEFAULTS.skip });
  }

  function handleClearStatus() {
    setDraftStatus('');
    setUrlState({ status: '', skip: URL_DEFAULTS.skip });
  }

  function handleApplyState() {
    setUrlState({ state: draftState, skip: URL_DEFAULTS.skip });
  }

  function handleClearState() {
    setDraftState(URL_DEFAULTS.state as ApprovalState);
    setUrlState({ state: URL_DEFAULTS.state, skip: URL_DEFAULTS.skip });
  }

  function handleSortChange(value: string) {
    if (kind === 'conflicts') {
      setUrlState({ sortDir: value, skip: URL_DEFAULTS.skip });
    } else {
      const [field, direction] = value.split('-');
      setUrlState({ sort: field, sortDir: direction, skip: URL_DEFAULTS.skip });
    }
  }

  function handleSelect(id: string) {
    setUrlState({ selected: id });
  }

  // A decided approval leaves the pending inbox — decide controls only render on a pending-state
  // row (`decide()` in `approvals.service.ts` rejects anything else), so removing it locally on
  // success matches what a re-fetch of the pending filter would show anyway. Guarded on the
  // applied filter, not just the row's own state, since `onDecided` only ever fires from a queue
  // that is currently showing pending rows.
  function handleDecided(id: string) {
    if (appliedState !== 'pending') return;
    setApprovals((current) => current?.filter((approval) => approval.id !== id) ?? current);
    setCount((current) => Math.max(0, current - 1));
  }

  const hasStatusFilter = appliedStatus !== '';
  const hasStateFilter = appliedState !== (URL_DEFAULTS.state as ApprovalState);
  const items = kind === 'conflicts' ? conflicts : approvals;
  const selectedConflict =
    (conflicts ?? []).find((conflict) => conflict.id === selectedId) ?? conflicts?.[0] ?? null;
  const selectedApproval =
    (approvals ?? []).find((approval) => approval.id === selectedId) ?? approvals?.[0] ?? null;

  let status: RecordListStatus;
  if (items === null) {
    status = error
      ? { kind: 'blank' }
      : { kind: 'loading', label: `Loading ${kind === 'conflicts' ? 'conflicts' : 'decisions'}…` };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Adjudication"
      title="Adjudication"
      description="Disagreements in the record and the human decisions that settle them."
      filters={
        <>
          <SegmentedControl<AdjudicationKind>
            aria-label="Adjudication kind"
            options={KIND_OPTIONS}
            value={kind}
            onChange={handleKindChange}
          />
          {kind === 'conflicts' ? (
            <FilterBar
              onApply={handleApplyStatus}
              onClear={handleClearStatus}
              hasFilter={hasStatusFilter}
            >
              <Select
                label="Status"
                options={STATUS_OPTIONS}
                value={draftStatus}
                onChange={(value) => setDraftStatus(value as ConflictStatus | '')}
              />
            </FilterBar>
          ) : (
            <FilterBar
              onApply={handleApplyState}
              onClear={handleClearState}
              hasFilter={hasStateFilter}
            >
              <Select
                label="State"
                options={STATE_OPTIONS}
                value={draftState}
                onChange={(value) => setDraftState(value as ApprovalState)}
              />
            </FilterBar>
          )}
          <div className="control-row">
            <div className="sort-select">
              <Select
                label="Sort"
                options={kind === 'conflicts' ? CONFLICT_SORT_OPTIONS : DECISION_SORT_OPTIONS}
                value={kind === 'conflicts' ? sortDir : `${sort}-${sortDir}`}
                onChange={handleSortChange}
              />
            </div>
          </div>
        </>
      }
      toolbarEnd={
        items && (
          <span className="mono cell-sub">
            {count} {kind === 'conflicts' ? 'conflict' : 'decision'}
            {count === 1 ? '' : 's'}
          </span>
        )
      }
      error={error ?? undefined}
      status={status}
      footer={
        items && (
          <Pager
            count={count}
            skip={skip}
            pageSize={PAGE_SIZE}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
          />
        )
      }
    >
      {items && items.length === 0 && kind === 'conflicts' && !hasStatusFilter && (
        <EmptyState
          className="empty-state--zero"
          icon={<IconAlertTriangle size={24} />}
          title="No conflicts"
          description="The evidence corpus currently agrees with itself — every extracted fact has a single value."
        />
      )}

      {items && items.length === 0 && kind === 'conflicts' && hasStatusFilter && (
        <EmptyState
          icon={<IconAlertTriangle size={24} />}
          title="No conflicts match this filter"
          description="Clear or adjust the status filter above."
          action={
            <Button variant="secondary" onClick={handleClearStatus}>
              Show all
            </Button>
          }
        />
      )}

      {items && items.length === 0 && kind === 'decisions' && appliedState === 'pending' && (
        <EmptyState
          className="empty-state--zero"
          icon={<IconCheck size={24} />}
          title="Nothing waiting on you"
          description="Every approval has been decided. New requests appear here as workflows park on them."
        />
      )}

      {items && items.length === 0 && kind === 'decisions' && appliedState !== 'pending' && (
        <EmptyState
          icon={<IconCheck size={24} />}
          title="No approvals match this filter"
          description="Clear or adjust the state filter above."
          action={
            <Button variant="secondary" onClick={handleClearState}>
              Show all
            </Button>
          }
        />
      )}

      {items && items.length > 0 && (
        <SplitView
          ratio="queue"
          primaryLabel="Adjudication queue"
          secondaryLabel="Case detail"
          primary={
            kind === 'conflicts' ? (
              <QueueList
                items={conflicts ?? []}
                selectedId={selectedConflict?.id ?? null}
                onSelect={handleSelect}
                ariaLabel="Conflicting facts extracted from the evidence corpus"
                renderItem={(conflict) => ({
                  identity: (
                    <>
                      <h2 className="card-title cell-truncate">{conflict.factKey.entity}</h2>
                      <Badge tone={conflictStatusTone(conflict.status)}>{conflict.status}</Badge>
                    </>
                  ),
                  quantifier: (
                    <>
                      {`${metricLabel(conflict.factKey.metric, metricLabels)} · ${conflict.factKey.period} · proposal ${proposalLabel(conflict)} · rule ${conflict.ruleFired ?? '—'} · ${
                        conflict.resolution
                          ? `${conflict.resolution.outcome} by ${conflict.resolution.decidedBy ?? 'policy'}${conflict.resolution.reason ? ` — ${conflict.resolution.reason}` : ''}`
                          : 'undecided'
                      }`}
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
            ) : (
              <QueueList
                items={approvals ?? []}
                selectedId={selectedApproval?.id ?? null}
                onSelect={handleSelect}
                ariaLabel="Decisions awaiting review"
                renderItem={(approval) => {
                  const conflict =
                    approval.subject.entityType === 'Conflict'
                      ? conflictsById.get(approval.subject.entityId)
                      : undefined;
                  return {
                    identity: (
                      <>
                        <h2 className="card-title cell-truncate">{approval.summary}</h2>
                        <Badge tone={approvalStateTone[approval.state]}>{approval.state}</Badge>
                      </>
                    ),
                    quantifier: (
                      <>
                        {`proposal ${proposalLabel(conflict)} · rule ${conflict?.ruleFired ?? '—'} · ${approval.decidedBy ?? 'undecided'}${approval.decisionReason ? ` — ${approval.decisionReason}` : ''}`}
                      </>
                    ),
                    age: (
                      <>
                        Requested <Timestamp value={approval.createdAt} />
                      </>
                    ),
                  };
                }}
              />
            )
          }
          secondary={
            kind === 'conflicts' ? (
              selectedConflict ? (
                <ConflictCase
                  conflict={selectedConflict}
                  metricLabels={metricLabels}
                  documentIndex={documentIndex}
                />
              ) : null
            ) : selectedApproval ? (
              <DecisionCase
                approval={selectedApproval}
                conflict={conflictsById.get(selectedApproval.subject.entityId)}
                metricLabels={metricLabels}
                documentIndex={documentIndex}
                canDecide={canDecide}
                sessionResolved={sessionResolved}
                onDecided={handleDecided}
              />
            ) : null
          }
        />
      )}
    </RecordListPage>
  );
}
