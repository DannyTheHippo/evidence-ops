import { useState } from 'react';
import {
  listWorkflowRuns,
  type SortDirection,
  type WorkflowRun,
  type WorkflowRunSortField,
  type WorkflowRunStatus,
  type WorkflowRunType,
} from '../api/client';
import { IconActivity } from '../components/icons';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import DateRange from '../components/ui/DateRange';
import EmptyState from '../components/ui/EmptyState';
import FilterBar from '../components/ui/FilterBar';
import LinkButton from '../components/ui/LinkButton';
import Pager from '../components/ui/Pager';
import Panel from '../components/ui/Panel';
import Select from '../components/ui/Select';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { RowLink, TableCell, TableRow } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import Tooltip from '../components/ui/Tooltip';
import {
  dateRangeKey,
  isDateRangeActive,
  readDateRange,
  toDateRangeInstants,
  writeDateRange,
} from '../lib/date-range';
import { WORKFLOW_TYPE_LABELS, shortId, workflowTypeLabel } from '../lib/identifiers';
import { clampPageSize, clampSkip, pickOption } from '../lib/paging';
import { runOutcomeView, runStatusView } from '../lib/run-status';
import { useAbortableEffect } from '../lib/use-latest';
import { useResultAnnouncer } from '../lib/use-result-announcer';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Matches the server's `@IsIn` lists in `list-workflow-runs.request.dto.ts`.
const SORT_FIELDS: readonly WorkflowRunSortField[] = ['createdAt', 'status', 'workflowType'];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

// Derived from `WORKFLOW_TYPE_LABELS` so this filter always covers every type the server can
// send — a value missing from that `Record<WorkflowRunType, string>` fails identifiers.ts to
// compile rather than staying unreachable here. `rescan-conflicts` has no current writer; the
// suffix keeps it selectable for an existing stored row without reading as a type the system
// still produces.
const WORKFLOW_TYPE_OPTIONS: { value: WorkflowRunType | ''; label: string }[] = [
  { value: '', label: 'All types' },
  ...(Object.entries(WORKFLOW_TYPE_LABELS) as [WorkflowRunType, string][]).map(
    ([value, label]) => ({
      value,
      label: value === 'rescan-conflicts' ? `${label} (legacy)` : label,
    }),
  ),
];

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both. Typed as
// plain `string` fields, not `as const` literals, so the values written back through
// `setUrlState` — themselves unions like `WorkflowRunSortField` — stay assignable.
const URL_DEFAULTS: Record<
  'status' | 'workflowType' | 'range' | 'from' | 'to' | 'limit' | 'sort' | 'sortDir' | 'skip',
  string
> = {
  status: '',
  workflowType: '',
  range: '',
  from: '',
  to: '',
  limit: '25',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
};

export default function RunsPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const appliedStatus = urlState.status as WorkflowRunStatus | '';
  const appliedWorkflowType = urlState.workflowType as WorkflowRunType | '';
  // A hand-edited or stale `sort`/`sortDir` falls back to the page default rather than reaching
  // the API with a value its `@IsIn` decorator refuses, which would otherwise blank the page.
  const sort = pickOption(urlState.sort, SORT_FIELDS, 'createdAt');
  const sortDir = pickOption(urlState.sortDir, SORT_DIRECTIONS, 'desc');
  const dateRange = readDateRange(urlState);
  const dateRangeActive = isDateRangeActive(dateRange);
  // `''` while the range filters nothing, so revealing an empty Custom range neither refetches nor
  // announces; the `DateRange` change handler below resets `skip` on the same key, so it stays put
  // too.
  const dateKey = dateRangeKey(dateRange);
  const skip = clampSkip(urlState.skip);
  const pageSize = clampPageSize(urlState.limit, PAGE_SIZE_OPTIONS, 25);
  const filterKey = JSON.stringify({
    status: appliedStatus,
    workflowType: appliedWorkflowType,
    date: dateKey,
  });

  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const announceResult = useResultAnnouncer();

  useAbortableEffect(
    (isCurrent) => {
      // Resolved here, not during render: a `24h` range yields new instants on every call.
      const { from, to } = toDateRangeInstants(dateRange);
      listWorkflowRuns({
        skip,
        limit: pageSize,
        status: appliedStatus === '' ? undefined : appliedStatus,
        workflowType: appliedWorkflowType === '' ? undefined : appliedWorkflowType,
        sort,
        sortDir,
        from,
        to,
      })
        .then(({ docs, count: total }) => {
          if (!isCurrent()) return;
          setRuns(docs);
          setCount(total);
          setError(null);
          announceResult(filterKey, `${total} run${total === 1 ? '' : 's'}`);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setError(err instanceof Error ? err.message : 'Failed to load workflow runs');
        });
    },
    [
      skip,
      pageSize,
      appliedStatus,
      appliedWorkflowType,
      sort,
      sortDir,
      dateKey,
      filterKey,
      announceResult,
    ],
  );

  function handleClear() {
    setUrlState({
      status: '',
      workflowType: '',
      range: '',
      from: '',
      to: '',
      skip: URL_DEFAULTS.skip,
    });
  }

  function handleSort(field: WorkflowRunSortField) {
    // Switching to a different column always starts it at `desc`; clicking the active column
    // toggles direction. A per-field default direction would make a URL written by one column
    // read back with the wrong direction once shared or reloaded, since `useUrlState` carries
    // exactly one default `sortDir` for every field.
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ sort: field, sortDir: nextDir, skip: URL_DEFAULTS.skip });
  }

  const hasFilter = appliedStatus !== '' || appliedWorkflowType !== '' || dateRangeActive;

  // Zero rows still resolves to `ready` rather than RecordListPage's own `empty` kind — that kind's
  // EmptyState carries no `className`, and the unfiltered case needs `empty-state--zero` to read as
  // an earned-zero state rather than a filtered-empty one.
  let status: RecordListStatus;
  if (runs === null) {
    status = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading workflow runs…' };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Runs"
      title="Runs"
      description="Workflow runs across questions, ingestion, sync, and resolution. Status is the last recorded value, not a live read of the workflow engine — open a run for its current state."
      filters={
        <FilterBar label="Run filters" onClear={handleClear} hasFilter={hasFilter}>
          <Select
            label="Status"
            width="md"
            options={STATUS_OPTIONS}
            value={appliedStatus}
            onChange={(value) => setUrlState({ status: value, skip: URL_DEFAULTS.skip })}
          />
          <Select
            label="Type"
            width="md"
            options={WORKFLOW_TYPE_OPTIONS}
            value={appliedWorkflowType}
            onChange={(value) => setUrlState({ workflowType: value, skip: URL_DEFAULTS.skip })}
          />
          <DateRange
            label="Created"
            value={dateRange}
            onChange={(value) =>
              setUrlState({
                ...writeDateRange(value),
                ...(dateRangeKey(value) !== dateKey ? { skip: URL_DEFAULTS.skip } : {}),
              })
            }
          />
        </FilterBar>
      }
      error={error ?? undefined}
      status={status}
      footer={
        runs && (
          <Pager
            count={count}
            skip={skip}
            pageSize={pageSize}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
            onPageSizeChange={(next) =>
              setUrlState({ limit: String(next), skip: URL_DEFAULTS.skip })
            }
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            showJump
          />
        )
      }
    >
      {runs && runs.length === 0 && hasFilter && (
        <EmptyState
          icon={<IconActivity size={24} />}
          title="No runs match this filter"
          description="Clear or adjust the status, type or date filters above."
          action={
            <Button variant="secondary" onClick={handleClear}>
              Show all runs
            </Button>
          }
        />
      )}

      {runs && runs.length === 0 && !hasFilter && (
        <EmptyState
          className="empty-state--zero"
          icon={<IconActivity size={24} />}
          title="No runs yet"
          description="Runs appear here once a question, ingestion, sync, or conflict resolution starts."
          action={<LinkButton to="/sources">Add a source</LinkButton>}
        />
      )}

      {runs && runs.length > 0 && (
        <Panel aria-label="Workflow runs, most recent first">
          <Table caption="Workflow runs, most recent first" className="runs-grid">
            <colgroup>
              <col className="col-wide" />
              <col />
              <col className="col-narrow" />
            </colgroup>
            <thead>
              <tr>
                {/* No Triggered-by column: this list view has no per-row space for the subject
                    link WorkflowRunPage renders — that stays a detail-page affordance. */}
                <SortableHeaderCell<WorkflowRunSortField>
                  field="workflowType"
                  label="Type"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<WorkflowRunSortField>
                  field="status"
                  label="Status"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<WorkflowRunSortField>
                  field="createdAt"
                  label="Created"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const statusView = runStatusView(run.status);
                return (
                  <TableRow key={run.id} to={`/workflow-runs/${run.id}`}>
                    <TableCell label="Type">
                      <RowLink to={`/workflow-runs/${run.id}`}>
                        {workflowTypeLabel(run.workflowType)}
                      </RowLink>
                      <p className="cell-sub mono">
                        <Tooltip content={run.workflowId}>
                          <span className="cell-truncate" tabIndex={0}>
                            {shortId(run.workflowId)}
                          </span>
                        </Tooltip>
                      </p>
                    </TableCell>
                    <TableCell label="Status">
                      <Badge tone={statusView.tone}>{statusView.label}</Badge>
                      {run.outcome && (
                        <p className="cell-sub">{runOutcomeView(run.outcome).label}</p>
                      )}
                      {run.status === 'failed' && run.errorMessage && (
                        <p className="cell-sub">
                          <Tooltip content={run.errorMessage}>
                            <span className="cell-truncate" tabIndex={0}>
                              {run.errorMessage}
                            </span>
                          </Tooltip>
                        </p>
                      )}
                      {run.status === 'failed' && !run.errorMessage && (
                        <p className="cell-sub">Reason not recorded</p>
                      )}
                    </TableCell>
                    <TableCell label="Created" className="cell-sub">
                      <Timestamp value={run.createdAt} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        </Panel>
      )}
    </RecordListPage>
  );
}
