import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { listAnswers, type Answer, type AnswerRunStatus } from '../api/client';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableHeaderCell } from '../components/ui/Table';

const PAGE_SIZE = 25;

const RUN_STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

type BadgeTone = 'verified' | 'caution' | 'rejected' | 'info' | 'neutral';

// A run still in flight shows its run status, never a premature outcome. Once completed, all
// three outcome kinds are first-class results, not a pass/fail collapse: `conflicting_evidence`
// is a real finding (caution), `insufficient_evidence` is a correct abstention (info) — neither
// reads as an error.
const RUN_STATUS_TONE: Record<Exclude<AnswerRunStatus, 'completed'>, BadgeTone> = {
  queued: 'neutral',
  running: 'info',
  failed: 'rejected',
};

function outcomeBadge(answer: Answer): { tone: BadgeTone; label: string } {
  if (answer.runStatus !== 'completed') {
    return { tone: RUN_STATUS_TONE[answer.runStatus], label: answer.runStatus };
  }
  switch (answer.outcome?.kind) {
    case 'answered':
      return { tone: 'verified', label: 'answered' };
    case 'conflicting_evidence':
      return { tone: 'caution', label: 'conflicting evidence' };
    case 'insufficient_evidence':
      return { tone: 'info', label: 'insufficient evidence' };
    default:
      return { tone: 'neutral', label: answer.runStatus };
  }
}

export default function AnswersPage() {
  const [answers, setAnswers] = useState<Answer[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skip, setSkip] = useState(0);
  const [runStatus, setRunStatus] = useState<AnswerRunStatus | ''>('');
  // Only this, not `runStatus` itself, drives the fetch — the filter applies on submit, not on
  // every selection change.
  const [appliedRunStatus, setAppliedRunStatus] = useState<AnswerRunStatus | ''>('');

  useEffect(() => {
    listAnswers({
      skip,
      limit: PAGE_SIZE,
      runStatus: appliedRunStatus === '' ? undefined : appliedRunStatus,
    })
      .then(({ docs, count: total }) => {
        setAnswers(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load answers');
      });
  }, [skip, appliedRunStatus]);

  function handleFilter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSkip(0);
    setAppliedRunStatus(runStatus);
  }

  const hasPrev = skip > 0;
  const hasNext = skip + PAGE_SIZE < count;
  const hasFilter = appliedRunStatus !== '';

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Ask</span>
          <h1 className="page-title">Answers</h1>
          <p className="page-sub">Answered questions and their grounding.</p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Filters</h2>
        </div>
        <form onSubmit={handleFilter} className="form">
          <Select
            label="Run status"
            options={RUN_STATUS_OPTIONS}
            value={runStatus}
            onChange={(value) => setRunStatus(value as AnswerRunStatus | '')}
          />
          <div className="form-actions">
            <Button type="submit" variant="primary">
              Apply filters
            </Button>
          </div>
        </form>
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!answers && !error && <Skeleton label="Loading…" />}

      {answers && answers.length === 0 && hasFilter && (
        <EmptyState
          title="No answers match this filter."
          description="Clear or adjust the run status filter above."
        />
      )}

      {answers && answers.length === 0 && !hasFilter && (
        <EmptyState
          title="No answers yet"
          description="Ask a question to see it appear here."
          action={
            <Link className="btn btn--primary" to="/ask">
              Ask a question
            </Link>
          }
        />
      )}

      {answers && answers.length > 0 && (
        <section className="panel">
          <Table caption="Answered questions and their grounding">
            <thead>
              <tr>
                <TableHeaderCell>Question</TableHeaderCell>
                <TableHeaderCell>Outcome</TableHeaderCell>
                <TableHeaderCell>Claim coverage</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell>
                  <span className="sr-only">View</span>
                </TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {answers.map((answer) => {
                const badge = outcomeBadge(answer);
                return (
                  <tr key={answer.id}>
                    <td>
                      <span className="cell-truncate" title={answer.questionText}>
                        {answer.questionText}
                      </span>
                    </td>
                    <td>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </td>
                    <td className="cell-sub">
                      {typeof answer.claimCoverage === 'number'
                        ? `${Math.round(answer.claimCoverage * 100)}%`
                        : '—'}
                    </td>
                    <td className="cell-sub">{new Date(answer.createdAt).toLocaleString()}</td>
                    <td className="cell-sub">
                      <Link to={`/answers/${answer.id}`}>View</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </section>
      )}

      {answers && (
        <div className="form-actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!hasPrev}
            onClick={() => setSkip((s) => Math.max(0, s - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!hasNext}
            onClick={() => setSkip((s) => s + PAGE_SIZE)}
          >
            Next
          </Button>
          <span className="cell-sub">{count} total</span>
        </div>
      )}
    </div>
  );
}
