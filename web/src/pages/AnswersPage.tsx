import { useEffect, useState } from 'react';
import {
  listAnswers,
  type Answer,
  type AnswerRunStatus,
  type AnswerSortField,
  type SortDirection,
} from '../api/client';
import { IconFileText } from '../components/icons';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge from '../components/ui/Badge';
import FilterBar from '../components/ui/FilterBar';
import LinkButton from '../components/ui/LinkButton';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { answerBadge } from '../lib/answer-status';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE = 25;

/** Buckets a 0–1 coverage fraction into one of eleven deciles (`0`–`10`) for
 * `coverage-meter--N`'s fill width — state stays on a modifier class rather than an inline
 * style. `1` rounds up to its own top decile rather than falling short of a full track. */
function coverageDecile(coverage: number): number {
  return Math.min(10, Math.max(0, Math.round(coverage * 10)));
}

const RUN_STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both. Typed as
// plain `string` fields, not `as const` literals, so the values written back through
// `setUrlState` — themselves unions like `AnswerSortField` — stay assignable.
const URL_DEFAULTS: Record<'runStatus' | 'sort' | 'sortDir' | 'skip', string> = {
  runStatus: '',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
};

export default function AnswersPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const appliedRunStatus = urlState.runStatus as AnswerRunStatus | '';
  const sort = urlState.sort as AnswerSortField;
  const sortDir = urlState.sortDir as SortDirection;
  const skip = Number(urlState.skip);

  // Only this, not the `Select`'s own value, drives the fetch — the filter applies on submit,
  // not on every selection change.
  const [draftRunStatus, setDraftRunStatus] = useState(appliedRunStatus);
  const [answers, setAnswers] = useState<Answer[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAnswers({
      skip,
      limit: PAGE_SIZE,
      runStatus: appliedRunStatus === '' ? undefined : appliedRunStatus,
      sort,
      sortDir,
    })
      .then(({ docs, count: total }) => {
        setAnswers(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load answers');
      });
  }, [skip, appliedRunStatus, sort, sortDir]);

  function handleApply() {
    setUrlState({ runStatus: draftRunStatus, skip: URL_DEFAULTS.skip });
  }

  function handleClear() {
    setDraftRunStatus('');
    setUrlState({ runStatus: '', skip: URL_DEFAULTS.skip });
  }

  function handleSort(field: AnswerSortField) {
    // Switching to a different column always starts it at `desc`; clicking the active column
    // toggles direction. A per-field default direction would make a URL written by one column
    // read back with the wrong direction once shared or reloaded, since `useUrlState` carries
    // exactly one default `sortDir` for every field.
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ sort: field, sortDir: nextDir, skip: URL_DEFAULTS.skip });
  }

  const hasFilter = appliedRunStatus !== '';

  let status: RecordListStatus;
  if (answers === null) {
    status = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading answers…' };
  } else if (answers.length === 0) {
    status = hasFilter
      ? {
          kind: 'empty',
          icon: <IconFileText size={24} />,
          title: 'No answers match this filter',
          description: 'Clear or adjust the run status filter above.',
        }
      : {
          kind: 'empty',
          icon: <IconFileText size={24} />,
          title: 'No answers yet',
          description: 'Ask a question to see it appear here.',
          action: <LinkButton to="/ask">Ask a question</LinkButton>,
        };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Ask"
      title="Answers"
      description="Answered questions and their grounding."
      filters={
        <FilterBar onApply={handleApply} onClear={handleClear} hasFilter={hasFilter}>
          <Select
            label="Run status"
            options={RUN_STATUS_OPTIONS}
            value={draftRunStatus}
            onChange={(value) => setDraftRunStatus(value as AnswerRunStatus | '')}
          />
        </FilterBar>
      }
      toolbarEnd={
        answers && (
          <span className="mono cell-sub">
            {count} answer{count === 1 ? '' : 's'}
          </span>
        )
      }
      error={error ?? undefined}
      status={status}
      skeletonVariant="table"
      footer={
        answers && (
          <Pager
            count={count}
            skip={skip}
            pageSize={PAGE_SIZE}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
          />
        )
      }
    >
      {answers && answers.length > 0 && (
        <section
          className="panel"
          tabIndex={0}
          role="region"
          aria-label="Answered questions and their grounding"
        >
          <Table caption="Answered questions and their grounding">
            <thead>
              <tr>
                <TableHeaderCell>Question</TableHeaderCell>
                <SortableHeaderCell<AnswerSortField>
                  field="runStatus"
                  label="Outcome"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<AnswerSortField>
                  field="claimCoverage"
                  label="Claim coverage"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<AnswerSortField>
                  field="createdAt"
                  label="Created"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
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
                      {answer.withdrawnCitedDocVersionIds.length > 0 && (
                        <Badge tone="caution">citation withdrawn</Badge>
                      )}
                    </TableCell>
                    <TableCell label="Claim coverage">
                      {typeof answer.claimCoverage === 'number' ? (
                        <div className="coverage-meter-cell">
                          <div
                            className={`coverage-meter coverage-meter--${coverageDecile(answer.claimCoverage)}`}
                            aria-hidden="true"
                          >
                            <div className="coverage-meter-fill" />
                          </div>
                          <span className="mono cell-sub">
                            {Math.round(answer.claimCoverage * 100)}%
                          </span>
                        </div>
                      ) : (
                        <span className="cell-sub">—</span>
                      )}
                    </TableCell>
                    <TableCell label="Created" className="cell-sub">
                      <Timestamp value={answer.createdAt} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        </section>
      )}
    </RecordListPage>
  );
}
