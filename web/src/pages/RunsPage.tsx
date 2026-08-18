import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listWorkflowRuns, type WorkflowRun, type WorkflowRunStatus } from '../api/client';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import Pager from '../components/ui/Pager';
import Skeleton from '../components/ui/Skeleton';
import Table, { RowLink, TableHeaderCell, TableRow } from '../components/ui/Table';
import { shortId, workflowTypeLabel } from '../lib/identifiers';

const PAGE_SIZE = 25;

const STATUS_TONE: Record<WorkflowRunStatus, 'verified' | 'info' | 'neutral' | 'rejected'> = {
  completed: 'verified',
  running: 'info',
  queued: 'neutral',
  failed: 'rejected',
};

export default function RunsPage() {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skip, setSkip] = useState(0);

  useEffect(() => {
    listWorkflowRuns({ skip, limit: PAGE_SIZE })
      .then(({ docs, count: total }) => {
        setRuns(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load workflow runs');
      });
  }, [skip]);

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Review</span>
          <h1 className="page-title">Runs</h1>
          <p className="page-sub">Workflow runs across ingestion, sync, and resolution.</p>
        </div>
      </div>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {!runs && !error && <Skeleton label="Loading…" />}

      {runs && runs.length === 0 && (
        <EmptyState
          title="No runs yet"
          description="Runs appear here once a question, ingestion, sync, or conflict resolution starts."
          action={
            <Link className="btn btn--primary" to="/ask">
              Ask a question
            </Link>
          }
        />
      )}

      {runs && runs.length > 0 && (
        <section className="panel">
          <Table caption="Workflow runs, most recent first">
            <thead>
              <tr>
                <TableHeaderCell>Run</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <TableRow key={run.id} to={`/workflow-runs/${run.id}`}>
                  <td>
                    <RowLink to={`/workflow-runs/${run.id}`}>
                      {workflowTypeLabel(run.workflowType)}
                    </RowLink>
                    <p className="cell-sub mono" title={run.workflowId}>
                      {shortId(run.workflowId)}
                    </p>
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
                    {run.status === 'failed' && run.errorMessage && (
                      <p className="cell-sub">{run.errorMessage}</p>
                    )}
                  </td>
                  <td className="cell-sub">{new Date(run.createdAt).toLocaleString()}</td>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {runs && <Pager count={count} skip={skip} pageSize={PAGE_SIZE} onSkipChange={setSkip} />}
    </div>
  );
}
