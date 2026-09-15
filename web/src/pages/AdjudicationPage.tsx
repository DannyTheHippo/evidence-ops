import { startTransition, useEffect, useRef, useState } from 'react';
import {
  ApiError,
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
import Alert from '../components/ui/Alert';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import FilterBar from '../components/ui/FilterBar';
import Pager from '../components/ui/Pager';
import SegmentedControl from '../components/ui/SegmentedControl';
import Select from '../components/ui/Select';
import SplitView from '../components/ui/SplitView';
import Timestamp from '../components/ui/Timestamp';
import Tooltip from '../components/ui/Tooltip';
import { approvalStateTone, conflictStatusTone } from '../lib/adjudication-status';
import { announce } from '../lib/announce';
import { resolveDocumentVersions, type ResolvedVersion } from '../lib/document-index';
import { formatValue } from '../lib/format-value';
import { useAbortableEffect } from '../lib/use-latest';
import { metricLabel, useMetricLabels } from '../lib/metric-labels';
import { clampPageSize, clampSkip, pickOption } from '../lib/paging';
import {
  invalidatePendingCounts,
  usePendingCounts,
  type PendingCounts,
} from '../lib/use-pending-counts';
import { useResultAnnouncer } from '../lib/use-result-announcer';
import { useSession } from '../lib/use-session';
import { useUrlState } from '../lib/use-url-state';
import ConflictCase from './adjudication/ConflictCase';
import DecisionCase from './adjudication/DecisionCase';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Bounds the pending-approval probe behind the conflict pane's "resolution pending" marker. Past
// this many pending approvals the marker is simply absent on the overflow, which is the same state
// a failed probe leaves.
const PENDING_PROBE_LIMIT = 100;

type AdjudicationKind = 'conflicts' | 'decisions';

// Counts come from the same `usePendingCounts()` pair the sidebar badge sums, so the two segments
// can never disagree with it; a failed leg resolves to `undefined` and the segment renders with no
// count rather than a stale or made-up one.
function kindOptions(
  counts: PendingCounts,
): { value: AdjudicationKind; label: string; count?: number }[] {
  return [
    { value: 'conflicts', label: 'Conflicts', count: counts.conflicts ?? undefined },
    { value: 'decisions', label: 'Decisions', count: counts.approvals ?? undefined },
  ];
}

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
// `SortableHeaderCell`) — the fetch below always sends `sort: 'createdAt'` for this kind, so the
// Sort select, last in the filter row, only needs to carry direction.
const CONFLICT_SORT_OPTIONS: { value: SortDirection; label: string }[] = [
  { value: 'desc', label: 'Newest first' },
  { value: 'asc', label: 'Oldest first' },
];

// Matches the server's `@IsIn` list in `list-approvals.request.dto.ts`. Conflicts ignore `sort`
// entirely (always `createdAt`, hardcoded below), so only `ApprovalSortField` needs a fallback set.
const DECISION_SORT_FIELDS: readonly ApprovalSortField[] = ['createdAt', 'state', 'decidedAt'];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

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
// is deep-link intent, honoured on the row it names — on-page or, for a conflict, fetched by id —
// and never substituted for a different row. Every list-changing handler resets it to this
// default so a page turn or a filter change never re-raises an off-page notice for a stale link.
const URL_DEFAULTS: Record<
  'kind' | 'status' | 'state' | 'sort' | 'sortDir' | 'skip' | 'selected' | 'limit',
  string
> = {
  kind: 'decisions',
  status: '',
  state: 'pending',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
  selected: '',
  limit: '25',
};

// Mongo's ObjectId shape — the only `selected` value the conflicts-by-id fetch is worth sending,
// since `list-conflicts.request.dto.ts` validates `ids` with `@IsMongoId({ each: true })` and
// rejects anything else with a 400.
const HEX_ID_RE = /^[0-9a-f]{24}$/;

/** What the off-page conflicts detail pane shows while `selected` names a row not on the loaded
 * page. `'idle'` covers every case that needs no by-id fetch — the selection is empty, on-page,
 * or (for the decisions kind) unreachable by id at all. */
type ByIdConflictState =
  | { status: 'idle' }
  | { status: 'malformed' }
  | { status: 'loading' }
  | { status: 'found'; conflict: Conflict }
  | { status: 'gone' }
  | { status: 'failed'; message: string };

/** The value `conflict.proposedWinnerFactId` points at, formatted for display — `'none'` when the
 *  id names no value in `conflict.values` (data drift) or the policy proposed none. */
function proposalLabel(conflict: Conflict | undefined): string {
  const winner = conflict?.values.find((value) => value.factId === conflict.proposedWinnerFactId);
  return winner ? formatValue(winner.value, winner.unit) : conflict ? 'none' : '—';
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
  // A hand-edited or stale `sort`/`sortDir` falls back to the page default rather than reaching
  // the API with a value its `@IsIn` decorator refuses, which would otherwise blank the page.
  // Conflicts hardcode `sort: 'createdAt'` below regardless, so only the decisions branch depends
  // on this validated value.
  const sort = pickOption(urlState.sort, DECISION_SORT_FIELDS, 'createdAt');
  const sortDir = pickOption(urlState.sortDir, SORT_DIRECTIONS, 'desc');
  const skip = clampSkip(urlState.skip);
  const pageSize = clampPageSize(urlState.limit, PAGE_SIZE_OPTIONS, 25);
  const selectedId = urlState.selected;
  const filterKey = JSON.stringify({ kind, status: appliedStatus, state: appliedState });

  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [conflictsById, setConflictsById] = useState<Map<string, Conflict>>(new Map());
  const [pendingApprovalByConflict, setPendingApprovalByConflict] = useState<Map<string, string>>(
    new Map(),
  );
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  const [byIdConflict, setByIdConflict] = useState<ByIdConflictState>({ status: 'idle' });
  const [byIdRetryToken, setByIdRetryToken] = useState(0);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinRetryToken, setJoinRetryToken] = useState(0);
  const [refetchToken, setRefetchToken] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  // Armed by a decision that asks for a reload, so the focus request waits for the reloaded rows
  // instead of landing on the decided row that reload is about to remove. The next load run
  // consumes it as it starts, and only that run's rows take the focus request: a run superseded
  // before it lands, by a kind switch or anything else, drops it, and no later load inherits it.
  const focusAfterReloadRef = useRef(false);
  const metricLabels = useMetricLabels();
  const counts = usePendingCounts();
  const announceResult = useResultAnnouncer();
  const session = useSession();
  // Fails CLOSED on the still-loading probe too, not just anon/error — a member (or a session
  // that hasn't resolved yet) never sees the decide controls flash in before the check lands.
  const canDecide = session.status === 'authed' && session.me.role === 'admin';
  const sessionResolved = session.status !== 'loading';

  useAbortableEffect(
    (isCurrent) => {
      const focusAfterLoad = focusAfterReloadRef.current;
      focusAfterReloadRef.current = false;
      if (kind === 'conflicts') {
        listConflicts({
          skip,
          limit: pageSize,
          status: appliedStatus === '' ? undefined : appliedStatus,
          sort: 'createdAt',
          sortDir,
        })
          .then(({ docs, count: total }) => {
            if (!isCurrent()) return;
            setConflicts(docs);
            setCount(total);
            setError(null);
            announceResult(filterKey, `${total} conflict${total === 1 ? '' : 's'}`);
          })
          .catch((err: unknown) => {
            if (!isCurrent()) return;
            setError(err instanceof Error ? err.message : 'Failed to load conflicts');
          });
      } else {
        listApprovals({
          skip,
          limit: pageSize,
          state: appliedState,
          sort,
          sortDir,
        })
          .then(({ docs, count: total }) => {
            if (!isCurrent()) return;
            setApprovals(docs);
            setCount(total);
            setError(null);
            announceResult(filterKey, `${total} decision${total === 1 ? '' : 's'}`);
            // Batched with `setApprovals` above, so the focus effect runs against the new rows.
            if (focusAfterLoad) setFocusRequest((n) => n + 1);
          })
          .catch((err: unknown) => {
            if (!isCurrent()) return;
            setError(err instanceof Error ? err.message : 'Failed to load approvals');
          });
      }
    },
    [
      kind,
      skip,
      pageSize,
      appliedStatus,
      appliedState,
      sort,
      sortDir,
      refetchToken,
      filterKey,
      announceResult,
    ],
  );

  // A conflict-resolution approval carries no proposal of its own — `subject.entityId` is the
  // conflict id, and the proposal (winner, rule, decision) lives on the conflict. `ids` fetches
  // every referenced conflict exactly, not a recency-bounded page. Kept as its own effect, keyed
  // on `joinRetryToken`, so a failed join can be retried without re-fetching the approvals page.
  useAbortableEffect(
    (isCurrent) => {
      if (kind !== 'decisions' || approvals === null) return;
      const conflictIds = [
        ...new Set(
          approvals
            .filter((approval) => approval.subject.entityType === 'Conflict')
            .map((approval) => approval.subject.entityId),
        ),
      ];
      if (conflictIds.length === 0) {
        setConflictsById(new Map());
        setJoinError(null);
        return;
      }
      listConflicts({ ids: conflictIds })
        .then((result) => {
          if (!isCurrent()) return;
          setConflictsById(new Map(result.docs.map((conflict) => [conflict.id, conflict])));
          setJoinError(null);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setJoinError(
            err instanceof Error ? err.message : 'Failed to load the referenced conflicts',
          );
        });
    },
    [kind, approvals, joinRetryToken],
  );

  // Marks the open conflicts that are already waiting on a resolution approval, which the conflict
  // DTO itself carries no field for. Fails OPEN: the probe decorates a server that is already the
  // authority on this, so a rejected read empties the map, and a tenant holding more pending
  // approvals than the bound fetches leaves the marker absent on the overflow. Either way every
  // action is offered and the 409 surfaces in the dialog — the probe never gates the request path.
  useAbortableEffect(
    (isCurrent) => {
      if (kind !== 'conflicts') return;
      listApprovals({ state: 'pending', limit: PENDING_PROBE_LIMIT })
        .then(({ docs }) => {
          if (!isCurrent()) return;
          setPendingApprovalByConflict(
            new Map(
              docs
                .filter((approval) => approval.subject.entityType === 'Conflict')
                .map((approval) => [approval.subject.entityId, approval.id]),
            ),
          );
        })
        .catch(() => {
          if (isCurrent()) setPendingApprovalByConflict(new Map());
        });
    },
    [kind],
  );

  // Resolves value document titles once there is something to resolve, folding in the off-page
  // conflict the by-id effect below found — without it, every one of its values would render
  // "Unknown document". Failure here must not affect conflict rendering — see document-index.ts.
  useAbortableEffect(
    (isCurrent) => {
      const base = kind === 'conflicts' ? (conflicts ?? []) : [...conflictsById.values()];
      const source = byIdConflict.status === 'found' ? [...base, byIdConflict.conflict] : base;
      if (source.length === 0) return;

      resolveDocumentVersions(
        source.flatMap((conflict) => conflict.values.map((value) => value.documentVersionId)),
      )
        .then((index) => {
          if (isCurrent()) setDocumentIndex(index);
        })
        .catch(() => {});
    },
    [kind, conflicts, conflictsById, byIdConflict],
  );

  function handleKindChange(next: AdjudicationKind) {
    setUrlState({ kind: next, skip: URL_DEFAULTS.skip, selected: URL_DEFAULTS.selected });
  }

  function handleStatusChange(value: string) {
    setUrlState({
      status: value,
      skip: URL_DEFAULTS.skip,
      selected: URL_DEFAULTS.selected,
    });
  }

  function handleClearStatus() {
    setUrlState({ status: '', skip: URL_DEFAULTS.skip, selected: URL_DEFAULTS.selected });
  }

  function handleStateChange(value: string) {
    setUrlState({
      state: value,
      skip: URL_DEFAULTS.skip,
      selected: URL_DEFAULTS.selected,
    });
  }

  function handleClearState() {
    setUrlState({
      state: URL_DEFAULTS.state,
      skip: URL_DEFAULTS.skip,
      selected: URL_DEFAULTS.selected,
    });
  }

  function handleSortChange(value: string) {
    if (kind === 'conflicts') {
      setUrlState({ sortDir: value, skip: URL_DEFAULTS.skip, selected: URL_DEFAULTS.selected });
    } else {
      const [field, direction] = value.split('-');
      setUrlState({
        sort: field,
        sortDir: direction,
        skip: URL_DEFAULTS.skip,
        selected: URL_DEFAULTS.selected,
      });
    }
  }

  function handleSelect(id: string) {
    setUrlState({ selected: id });
  }

  // A decided approval leaves the pending inbox — decide controls only render on a pending-state
  // row (`decide()` in `approvals.service.ts` rejects anything else), so removing it locally on
  // success matches what a re-fetch of the pending filter would show anyway. Guarded on the
  // applied filter, not just the row's own state, since `onDecided` only ever fires from a queue
  // that is currently showing pending rows. `refetch` is set when the server rejected the decision
  // as already-settled (404/409): local removal would not match what the server actually holds, so
  // the current page is reloaded instead, and the focus request waits for that reload to land.
  // Either way the badge and the focus target are refreshed.
  // A decided approval that `selected` names also clears the selection, so the first remaining row
  // takes its place instead of the pane reporting the just-decided approval as missing from the
  // queue. `setUrlState` commits inside the router's transition, so every update here runs in one
  // transition too. On local removal the row removal, the cleared selection and the focus request
  // land in a single commit; on a reload the cleared selection lands with the reload request, ahead
  // of the reloaded rows and their focus request. Either way neither the off-page notice nor the
  // focus effect ever sees the decided id selected.
  function handleDecided(id: string, options?: { refetch?: boolean }) {
    invalidatePendingCounts();
    startTransition(() => {
      if (options?.refetch) {
        if (selectedId === id) setUrlState({ selected: URL_DEFAULTS.selected });
        focusAfterReloadRef.current = true;
        setRefetchToken((n) => n + 1);
        return;
      }
      setFocusRequest((n) => n + 1);
      if (appliedState !== 'pending') return;
      setApprovals((current) => current?.filter((approval) => approval.id !== id) ?? current);
      setCount((current) => Math.max(0, current - 1));
      if (selectedId === id) setUrlState({ selected: URL_DEFAULTS.selected });
    });
  }

  // Moves focus off the just-decided row after it leaves the queue: to the row that took its
  // place, or to the page heading when the queue emptied — `App.tsx`'s own post-navigation target.
  // A row still on screen keeps its own accessible name as the announcement; an emptied queue has
  // no row left to speak for it, so the empty state's own title is read out instead.
  useEffect(() => {
    if (focusRequest === 0) return;
    const row = document.querySelector<HTMLElement>('.queue-item[aria-current="true"]');
    if (row) {
      row.focus();
      return;
    }
    const heading = document.querySelector<HTMLElement>('#main-content h1');
    heading?.focus();
    const emptyTitle = document.querySelector('.empty-state-title')?.textContent;
    if (emptyTitle) announce(emptyTitle);
  }, [focusRequest]);

  const hasStatusFilter = appliedStatus !== '';
  const hasStateFilter = appliedState !== (URL_DEFAULTS.state as ApprovalState);
  const items = kind === 'conflicts' ? conflicts : approvals;

  // `selected` is deep-link intent, never a sticky substitution: an empty selection takes the
  // first row, an on-page id takes its row, and anything else resolves to `null` here — the
  // by-id effect below, or the decisions off-page notice, decides what the pane shows instead.
  const conflictOnPage =
    selectedId !== ''
      ? (conflicts ?? []).find((conflict) => conflict.id === selectedId)
      : undefined;
  const approvalOnPage =
    selectedId !== ''
      ? (approvals ?? []).find((approval) => approval.id === selectedId)
      : undefined;
  const selectedConflict = selectedId === '' ? (conflicts?.[0] ?? null) : (conflictOnPage ?? null);
  const selectedApproval = selectedId === '' ? (approvals?.[0] ?? null) : (approvalOnPage ?? null);

  // Evaluated only once the relevant list has resolved, so the common on-page Home-link case
  // never pays a second request while the page is still loading.
  const isConflictOffPage =
    kind === 'conflicts' && conflicts !== null && selectedId !== '' && conflictOnPage === undefined;
  const isDecisionOffPage =
    kind === 'decisions' && approvals !== null && selectedId !== '' && approvalOnPage === undefined;

  useAbortableEffect(
    (isCurrent) => {
      if (kind !== 'conflicts' || !isConflictOffPage) {
        setByIdConflict({ status: 'idle' });
        return;
      }
      if (!HEX_ID_RE.test(selectedId)) {
        setByIdConflict({ status: 'malformed' });
        return;
      }
      setByIdConflict({ status: 'loading' });
      listConflicts({ ids: [selectedId] })
        .then(({ docs }) => {
          if (!isCurrent()) return;
          const found = docs[0];
          setByIdConflict(found ? { status: 'found', conflict: found } : { status: 'gone' });
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          if (err instanceof ApiError && err.status === 400) {
            setByIdConflict({ status: 'gone' });
            return;
          }
          setByIdConflict({
            status: 'failed',
            message: err instanceof Error ? err.message : 'Failed to load the linked conflict',
          });
        });
    },
    [kind, selectedId, isConflictOffPage, byIdRetryToken],
  );

  function showQueue() {
    setUrlState({ selected: URL_DEFAULTS.selected });
  }

  // Shared between the two places it can render: inside `SplitView` beside a populated queue, and
  // on its own when the loaded page has no rows to pair it with — an off-page selection is never
  // silently dropped just because the page it would have shared a screen with came back empty.
  const secondaryContent =
    kind === 'conflicts' ? (
      selectedConflict ? (
        <ConflictCase
          conflict={selectedConflict}
          metricLabels={metricLabels}
          documentIndex={documentIndex}
          pendingApprovalId={pendingApprovalByConflict.get(selectedConflict.id)}
        />
      ) : isConflictOffPage ? (
        byIdConflict.status === 'found' ? (
          <>
            <Alert
              tone="info"
              action={
                <Button variant="secondary" onClick={showQueue}>
                  Show the queue
                </Button>
              }
            >
              Not in the list below — showing the conflict this link names.
            </Alert>
            <ConflictCase
              conflict={byIdConflict.conflict}
              metricLabels={metricLabels}
              documentIndex={documentIndex}
              pendingApprovalId={pendingApprovalByConflict.get(byIdConflict.conflict.id)}
            />
          </>
        ) : byIdConflict.status === 'failed' ? (
          <Alert
            tone="rejected"
            action={
              <Button variant="secondary" onClick={() => setByIdRetryToken((n) => n + 1)}>
                Retry
              </Button>
            }
          >
            {byIdConflict.message}
          </Alert>
        ) : byIdConflict.status === 'loading' ? null : (
          <Alert
            tone="caution"
            action={
              <Button variant="secondary" onClick={showQueue}>
                Show the queue
              </Button>
            }
          >
            That conflict is no longer in the record.
          </Alert>
        )
      ) : null
    ) : selectedApproval ? (
      <>
        {joinError && (
          <Alert
            tone="caution"
            title="Couldn't load the conflict behind this decision"
            action={
              <Button variant="secondary" onClick={() => setJoinRetryToken((n) => n + 1)}>
                Retry
              </Button>
            }
          >
            {joinError}
          </Alert>
        )}
        <DecisionCase
          key={selectedApproval.id}
          approval={selectedApproval}
          conflict={conflictsById.get(selectedApproval.subject.entityId)}
          metricLabels={metricLabels}
          documentIndex={documentIndex}
          canDecide={canDecide}
          sessionResolved={sessionResolved}
          onDecided={handleDecided}
        />
      </>
    ) : isDecisionOffPage ? (
      <Alert
        tone="caution"
        action={
          <Button variant="secondary" onClick={showQueue}>
            Show the queue
          </Button>
        }
      >
        That decision isn&apos;t in this queue. It may already be decided, or it may be on another
        page.
      </Alert>
    ) : null;

  // An unresolved deep-link selection is never treated as "no rows" — it is content the page owes
  // an answer to, on-page or off, so it pre-empts every empty state below it.
  const hasUnresolvedSelection = kind === 'conflicts' ? isConflictOffPage : isDecisionOffPage;

  // The page the URL names has fallen empty under the current filter — a stale `skip` after a
  // filter tightened, or the last row on a page left it. There is content on earlier pages, so
  // this is not the earned-zero state.
  function handlePreviousPage() {
    setUrlState({
      skip: String(Math.max(0, skip - pageSize)),
      selected: URL_DEFAULTS.selected,
    });
  }

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
      view={
        <SegmentedControl<AdjudicationKind>
          aria-label="Adjudication kind"
          options={kindOptions(counts)}
          value={kind}
          onChange={handleKindChange}
        />
      }
      filters={
        kind === 'conflicts' ? (
          <FilterBar
            label="Conflict filters"
            onClear={handleClearStatus}
            hasFilter={hasStatusFilter}
          >
            <Select
              label="Status"
              width="sm"
              options={STATUS_OPTIONS}
              value={appliedStatus}
              onChange={handleStatusChange}
            />
            <Select
              label="Sort"
              width="sm"
              options={CONFLICT_SORT_OPTIONS}
              value={sortDir}
              onChange={handleSortChange}
            />
          </FilterBar>
        ) : (
          <FilterBar label="Decision filters" onClear={handleClearState} hasFilter={hasStateFilter}>
            <Select
              label="State"
              width="sm"
              options={STATE_OPTIONS}
              value={appliedState}
              onChange={handleStateChange}
            />
            <Select
              label="Sort"
              width="sm"
              options={DECISION_SORT_OPTIONS}
              value={`${sort}-${sortDir}`}
              onChange={handleSortChange}
            />
          </FilterBar>
        )
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
            pageSize={pageSize}
            onSkipChange={(next) =>
              setUrlState({ skip: String(next), selected: URL_DEFAULTS.selected })
            }
            onPageSizeChange={(next) =>
              setUrlState({
                limit: String(next),
                skip: URL_DEFAULTS.skip,
                selected: URL_DEFAULTS.selected,
              })
            }
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        )
      }
    >
      {items &&
        items.length === 0 &&
        (hasUnresolvedSelection ? (
          secondaryContent
        ) : count === 0 ? (
          kind === 'conflicts' ? (
            !hasStatusFilter ? (
              <EmptyState
                className="empty-state--zero"
                icon={<IconAlertTriangle size={24} />}
                title="No conflicts"
                description="The evidence corpus currently agrees with itself — every extracted fact has a single value."
              />
            ) : (
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
            )
          ) : appliedState === 'pending' ? (
            <EmptyState
              className="empty-state--zero"
              icon={<IconCheck size={24} />}
              title="Nothing waiting on you"
              description="Every approval has been decided. New requests appear here as workflows park on them."
            />
          ) : (
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
          )
        ) : (
          <EmptyState
            title="Nothing on this page"
            description={`Rows ${skip + 1}–${skip + pageSize} are empty. The queue has ${count}.`}
            action={
              <Button variant="secondary" onClick={handlePreviousPage}>
                Go to the previous page
              </Button>
            }
          />
        ))}

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
                  name: `${conflict.factKey.entity} — ${conflict.status}`,
                  identity: (
                    <>
                      {/* Plain text, not a heading: the row is a `<button>`, whose content model
                          admits no heading element. The tooltip recovers an entity the row
                          truncates, on hover only — a span inside a button takes no focus of its
                          own — so the case pane stays the non-pointer route to the full name. */}
                      <Tooltip content={conflict.factKey.entity}>
                        <span className="card-title cell-truncate">{conflict.factKey.entity}</span>
                      </Tooltip>
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
                  // Carried only for a subject that has a conflict behind it — a subject of another
                  // type has no proposal at all, and a placeholder there would read as a conflict
                  // whose proposal is missing.
                  const proposal = conflict
                    ? `proposal ${proposalLabel(conflict)} · rule ${conflict.ruleFired ?? '—'} · `
                    : '';
                  // A timed-out approval expired without anyone deciding it, which is a different
                  // state from one still waiting on a decider.
                  const outcome =
                    approval.state === 'timed_out'
                      ? 'timed out'
                      : approval.decidedBy
                        ? `${approval.state} by ${approval.decidedBy}${approval.decisionReason ? ` — ${approval.decisionReason}` : ''}`
                        : 'undecided';
                  return {
                    name: `${approval.summary} — ${approval.state}`,
                    identity: (
                      <>
                        {/* Plain text, not a heading: the row is a `<button>`, whose content model
                            admits no heading element. The tooltip recovers a summary the row
                            truncates, on hover only — a span inside a button takes no focus of its
                            own — so the case pane stays the non-pointer route to the full text. */}
                        <Tooltip content={approval.summary}>
                          <span className="card-title cell-truncate">{approval.summary}</span>
                        </Tooltip>
                        <Badge tone={approvalStateTone[approval.state]}>{approval.state}</Badge>
                      </>
                    ),
                    quantifier: <>{`${proposal}${outcome}`}</>,
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
          secondary={secondaryContent}
        />
      )}
    </RecordListPage>
  );
}
