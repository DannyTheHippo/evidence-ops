import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { listAnswers, type Answer, type AnswerRunStatus } from '../api/client';
import { IconFileText } from '../components/icons';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../components/ui/Table';
import { answerBadge } from '../lib/answer-status';

const PAGE_SIZE = 25;

const RUN_STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

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

  const hasFilter = appliedRunStatus !== '';

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Ask</span>
          <h1 className="page-title">Answers</h1>
          <p className="page-sub">Answered questions and their grounding.</p>
        </div>
      </div>

      <form onSubmit={handleFilter} className="control-row">
        <Select
          label="Run status"
          options={RUN_STATUS_OPTIONS}
          value={runStatus}
          onChange={(value) => setRunStatus(value as AnswerRunStatus | '')}
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

      {!answers && !error && <Skeleton label="Loading answers…" />}

      {answers && answers.length === 0 && hasFilter && (
        <EmptyState
          icon={<IconFileText size={24} />}
          title="No answers match this filter"
          description="Clear or adjust the run status filter above."
        />
      )}

      {answers && answers.length === 0 && !hasFilter && (
        <EmptyState
          icon={<IconFileText size={24} />}
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
              </tr>
            </thead>
            <tbody>
              {answers.map((answer) => {
                const badge = answerBadge(answer);
                return (
                  <TableRow key={answer.id} to={`/answers/${answer.id}`}>
                    <TableCell label="Question">
                      <RowLink to={`/answers/${answer.id}`}>
                        <span className="cell-truncate" title={answer.questionText}>
                          {answer.questionText}
                        </span>
                      </RowLink>
                    </TableCell>
                    <TableCell label="Outcome">
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell label="Claim coverage" className="cell-sub">
                      {typeof answer.claimCoverage === 'number'
                        ? `${Math.round(answer.claimCoverage * 100)}%`
                        : '—'}
                    </TableCell>
                    <TableCell label="Created" className="cell-sub">
                      {new Date(answer.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        </section>
      )}

      {answers && <Pager count={count} skip={skip} pageSize={PAGE_SIZE} onSkipChange={setSkip} />}
    </div>
  );
}
