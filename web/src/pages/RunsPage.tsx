import { useEffect, useState } from 'react';
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
import EmptyState from '../components/ui/EmptyState';
import FilterBar from '../components/ui/FilterBar';
import LinkButton from '../components/ui/LinkButton';
import Pager from '../components/ui/Pager';
import Panel from '../components/ui/Panel';
import Select from '../components/ui/Select';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { RowLink, TableCell, TableRow } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { shortId, workflowTypeLabel } from '../lib/identifiers';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE = 25;

const STATUS_TONE: Record<WorkflowRunStatus, 'verified' | 'info' | 'neutral' | 'rejected'> = {
  completed: 'verified',
  running: 'info',
  queued: 'neutral',
  failed: 'rejected',
};

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

// `rescan-conflicts` has no current writer (client.ts's `WorkflowRunType`) — kept selectable only
// so an existing stored row stays reachable, labelled as legacy so it doesn't read as a type the
// system still produces.
const WORKFLOW_TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'resolve-conflict', label: 'Conflict resolution' },
  { value: 'sync-source', label: 'Source sync' },
  { value: 'rescan-conflicts', label: 'Conflict rescan (legacy)' },
];

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both. Typed as
// plain `string` fields, not `as const` literals, so the values written back through
// `setUrlState` — themselves unions like `WorkflowRunSortField` — stay assignable.
const URL_DEFAULTS: Record<'status' | 'workflowType' | 'sort' | 'sortDir' | 'skip', string> = {
  status: '',
  workflowType: '',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
};

export default function RunsPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const appliedStatus = urlState.status as WorkflowRunStatus | '';
  const appliedWorkflowType = urlState.workflowType as WorkflowRunType | '';
  const sort = urlState.sort as WorkflowRunSortField;
  const sortDir = urlState.sortDir as SortDirection;
  const skip = Number(urlState.skip);

  // Only these, not the `Select`s' own values, drive the fetch — the filter applies on submit,
  // not on every selection change.
  const [draftStatus, setDraftStatus] = useState(appliedStatus);
  const [draftWorkflowType, setDraftWorkflowType] = useState(appliedWorkflowType);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listWorkflowRuns({
      skip,
      limit: PAGE_SIZE,
      status: appliedStatus === '' ? undefined : appliedStatus,
      workflowType: appliedWorkflowType === '' ? undefined : appliedWorkflowType,
      sort,
      sortDir,
    })
      .then(({ docs, count: total }) => {
        setRuns(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load workflow runs');
      });
  }, [skip, appliedStatus, appliedWorkflowType, sort, sortDir]);

  function handleApply() {
    setUrlState({
      status: draftStatus,
      workflowType: draftWorkflowType,
      skip: URL_DEFAULTS.skip,
    });
  }

  function handleClear() {
    setDraftStatus('');
    setDraftWorkflowType('');
    setUrlState({ status: '', workflowType: '', skip: URL_DEFAULTS.skip });
  }

  function handleSort(field: WorkflowRunSortField) {
    // Switching to a different column always starts it at `desc`; clicking the active column
    // toggles direction. A per-field default direction would make a URL written by one column
    // read back with the wrong direction once shared or reloaded, since `useUrlState` carries
    // exactly one default `sortDir` for every field.
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ sort: field, sortDir: nextDir, skip: URL_DEFAULTS.skip });
  }

  const hasFilter = appliedStatus !== '' || appliedWorkflowType !== '';

  // Zero rows still resolves to `ready` rather than RecordListPage's own `empty` kind — that kind's
  // EmptyState carries no `className`, and the unfiltered case needs `empty-state--zero`, matching
  // ApprovalsPage's identical split between an earned-zero state and a filtered-empty one.
  let status: RecordListStatus;
  if (runs === null) {
    status = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading workflow runs…' };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Review"
      title="Runs"
      description="Workflow runs across ingestion, sync, and resolution. Status is the last recorded value, not a live read of the workflow engine — open a run for its current state."
      filters={
        <FilterBar onApply={handleApply} onClear={handleClear} hasFilter={hasFilter}>
          <Select
            label="Status"
            options={STATUS_OPTIONS}
            value={draftStatus}
            onChange={(value) => setDraftStatus(value as WorkflowRunStatus | '')}
          />
          <Select
            label="Type"
            options={WORKFLOW_TYPE_OPTIONS}
            value={draftWorkflowType}
            onChange={(value) => setDraftWorkflowType(value as WorkflowRunType | '')}
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
            pageSize={PAGE_SIZE}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
          />
        )
      }
    >
      {runs && runs.length === 0 && hasFilter && (
        <EmptyState
          icon={<IconActivity size={24} />}
          title="No runs match this filter"
          description="Clear or adjust the status or type filter above."
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
          action={<LinkButton to="/ask">Ask a question</LinkButton>}
        />
      )}

      {runs && runs.length > 0 && (
        <Panel aria-label="Workflow runs, most recent first">
          <Table caption="Workflow runs, most recent first">
            <thead>
              <tr>
                {/* No Triggered-by column: `subjectId`/`subjectType` are unset on every
                    resolve-conflict and sync-source run (client.ts's `WorkflowRun`), so a
                    rendered column would carry no content on effectively every row. */}
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
              {runs.map((run) => (
                <TableRow key={run.id} to={`/workflow-runs/${run.id}`}>
                  <TableCell label="Type">
                    <RowLink to={`/workflow-runs/${run.id}`}>
                      {workflowTypeLabel(run.workflowType)}
                    </RowLink>
                    <p className="cell-sub mono" title={run.workflowId}>
                      {shortId(run.workflowId)}
                    </p>
                  </TableCell>
                  <TableCell label="Status">
                    <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
                    {run.status === 'failed' && run.errorMessage && (
                      <p className="cell-sub">
                        <span className="cell-truncate" title={run.errorMessage}>
                          {run.errorMessage}
                        </span>
                      </p>
                    )}
                  </TableCell>
                  <TableCell label="Created" className="cell-sub">
                    <Timestamp value={run.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
    </RecordListPage>
  );
}
