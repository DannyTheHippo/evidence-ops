import { useEffect, useState } from 'react';
import {
  listAnswers,
  listVerifications,
  type Answer,
  type AnswerRunStatus,
  type AnswerSortField,
  type ClaimVerdict,
  type SortDirection,
  type Verification,
  type VerifyClaimResult,
} from '../api/client';
import { IconFileText } from '../components/icons';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge from '../components/ui/Badge';
import FilterBar from '../components/ui/FilterBar';
import Pager from '../components/ui/Pager';
import Panel from '../components/ui/Panel';
import SegmentedControl from '../components/ui/SegmentedControl';
import Select from '../components/ui/Select';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { answerBadge } from '../lib/answer-status';
import { useUrlState } from '../lib/use-url-state';
import AnswerComposer from './answers/AnswerComposer';

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

type HistoryKind = 'answers' | 'verifications';

const KIND_OPTIONS: { value: HistoryKind; label: string }[] = [
  { value: 'answers', label: 'Answers' },
  { value: 'verifications', label: 'Verifications' },
];

const VERDICT_LABELS: Record<ClaimVerdict, string> = {
  grounded: 'grounded',
  not_grounded: 'not grounded',
  no_evidence_retrieved: 'no evidence retrieved',
  conflicting_evidence: 'conflicting evidence',
};

/** Tallies a verification run's per-claim verdicts into one mono line, in `VERDICT_LABELS`
 * order, omitting any verdict no claim in the run reached. */
function verdictTally(results: VerifyClaimResult[]): string {
  const counts = new Map<ClaimVerdict, number>();
  for (const result of results) {
    counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  }
  return (Object.keys(VERDICT_LABELS) as ClaimVerdict[])
    .filter((verdict) => (counts.get(verdict) ?? 0) > 0)
    .map((verdict) => `${counts.get(verdict)} ${VERDICT_LABELS[verdict]}`)
    .join(' · ');
}

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both. Typed as
// plain `string` fields, not `as const` literals, so the values written back through
// `setUrlState` — themselves unions like `AnswerSortField` — stay assignable.
const URL_DEFAULTS: Record<'q' | 'kind' | 'runStatus' | 'sort' | 'sortDir' | 'skip', string> = {
  q: '',
  kind: 'answers',
  runStatus: '',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
};

export default function AnswersPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const kind = urlState.kind as HistoryKind;
  const appliedRunStatus = urlState.runStatus as AnswerRunStatus | '';
  const sort = urlState.sort as AnswerSortField;
  const sortDir = urlState.sortDir as SortDirection;
  const skip = Number(urlState.skip);

  // Only this, not the `Select`'s own value, drives the fetch — the filter applies on submit,
  // not on every selection change.
  const [draftRunStatus, setDraftRunStatus] = useState(appliedRunStatus);
  const [answers, setAnswers] = useState<Answer[] | null>(null);
  const [verifications, setVerifications] = useState<Verification[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the composer once a run has been seeded, so the history list refetches and the new
  // `queued` row appears — the composer's own submit never navigates away from this page.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (kind === 'answers') {
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
    } else {
      listVerifications({ skip, limit: PAGE_SIZE, sort: 'createdAt', sortDir })
        .then(({ docs, count: total }) => {
          setVerifications(docs);
          setCount(total);
          setError(null);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Failed to load verifications');
        });
    }
  }, [kind, skip, appliedRunStatus, sort, sortDir, reloadKey]);

  // A rephrase link elsewhere carries `?q=` into this page; the composer adopts it into its draft
  // on render, and this strips it right after so a later reload can't overwrite a newer draft.
  useEffect(() => {
    if (urlState.q) setUrlState({ q: '' });
  }, [urlState.q, setUrlState]);

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

  function handleKindChange(next: HistoryKind) {
    // The sort resets with the kind: `claimCoverage`/`runStatus` carried over from the answers
    // kind would leave the verifications `Created` header reading as inactive.
    setUrlState({ kind: next, skip: URL_DEFAULTS.skip, sort: URL_DEFAULTS.sort });
  }

  const hasFilter = kind === 'answers' && appliedRunStatus !== '';
  const items = kind === 'answers' ? answers : verifications;

  let status: RecordListStatus;
  if (items === null) {
    status = error
      ? { kind: 'blank' }
      : { kind: 'loading', label: `Loading ${kind === 'answers' ? 'answers' : 'verifications'}…` };
  } else if (items.length === 0) {
    if (kind === 'verifications') {
      status = {
        kind: 'empty',
        icon: <IconFileText size={24} />,
        title: 'No verifications yet',
        description: 'Runs of verify_claims over MCP appear here.',
      };
    } else if (hasFilter) {
      status = {
        kind: 'empty',
        icon: <IconFileText size={24} />,
        title: 'No answers match this filter',
        description: 'Clear or adjust the run status filter above.',
      };
    } else {
      status = {
        kind: 'empty',
        icon: <IconFileText size={24} />,
        title: 'No answers yet',
        description: 'Ask a question above to see it appear here.',
      };
    }
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Answers"
      title="Answers"
      description="Ask a question, and read every answer and verification the record has produced."
      lead={
        <AnswerComposer
          initialQuestion={urlState.q}
          onRunStarted={() => setReloadKey((n) => n + 1)}
        />
      }
      filters={
        <>
          <SegmentedControl<HistoryKind>
            aria-label="History kind"
            options={KIND_OPTIONS}
            value={kind}
            onChange={handleKindChange}
          />
          {kind === 'answers' && (
            <FilterBar onApply={handleApply} onClear={handleClear} hasFilter={hasFilter}>
              <Select
                label="Run status"
                options={RUN_STATUS_OPTIONS}
                value={draftRunStatus}
                onChange={(value) => setDraftRunStatus(value as AnswerRunStatus | '')}
              />
            </FilterBar>
          )}
        </>
      }
      toolbarEnd={
        items && (
          <span className="mono cell-sub">
            {count} {kind === 'answers' ? 'answer' : 'verification'}
            {count === 1 ? '' : 's'}
          </span>
        )
      }
      error={error ?? undefined}
      status={status}
      skeletonVariant="table"
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
      {items && items.length > 0 && (
        <Panel aria-label="Answers and verifications">
          <Table caption="Answers and verifications with their grounding">
            <thead>
              <tr>
                <TableHeaderCell>Subject</TableHeaderCell>
                <TableHeaderCell>Kind</TableHeaderCell>
                {kind === 'answers' ? (
                  <SortableHeaderCell<AnswerSortField>
                    field="runStatus"
                    label="Result"
                    sort={sort}
                    direction={sortDir}
                    onSort={handleSort}
                  />
                ) : (
                  <TableHeaderCell>Result</TableHeaderCell>
                )}
                <TableHeaderCell>Path</TableHeaderCell>
                {kind === 'answers' ? (
                  <SortableHeaderCell<AnswerSortField>
                    field="claimCoverage"
                    label="Coverage"
                    sort={sort}
                    direction={sortDir}
                    onSort={handleSort}
                  />
                ) : (
                  <TableHeaderCell>Coverage</TableHeaderCell>
                )}
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
              {kind === 'answers'
                ? (answers ?? []).map((answer) => {
                    const badge = answerBadge(answer);
                    return (
                      <TableRow key={answer.id} to={`/answers/${answer.id}`}>
                        <TableCell label="Subject">
                          <RowLink to={`/answers/${answer.id}`}>
                            <span className="cell-truncate" title={answer.questionText}>
                              {answer.questionText}
                            </span>
                          </RowLink>
                        </TableCell>
                        <TableCell label="Kind">
                          <Badge tone="info">answer</Badge>
                        </TableCell>
                        <TableCell label="Result">
                          <Badge tone={badge.tone}>{badge.label}</Badge>
                          {answer.withdrawnCitedDocVersionIds.length > 0 && (
                            <Badge tone="caution">citation withdrawn</Badge>
                          )}
                        </TableCell>
                        <TableCell label="Path">
                          {answer.answerPath ? (
                            <span className="mono">{answer.answerPath}</span>
                          ) : (
                            <span className="cell-sub">—</span>
                          )}
                        </TableCell>
                        <TableCell label="Coverage">
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
                  })
                : (verifications ?? []).map((verification) => (
                    <TableRow
                      key={verification.id}
                      to={`/answers/verifications/${verification.id}`}
                    >
                      <TableCell label="Subject">
                        <RowLink to={`/answers/verifications/${verification.id}`}>
                          <span className="cell-truncate" title={verification.claims.join(' | ')}>
                            {verification.claims[0]}
                            {verification.claims.length > 1 &&
                              ` +${verification.claims.length - 1} more`}
                          </span>
                        </RowLink>
                      </TableCell>
                      <TableCell label="Kind">
                        <Badge tone="neutral">verification</Badge>
                      </TableCell>
                      <TableCell label="Result" className="mono">
                        {verdictTally(verification.results)}
                      </TableCell>
                      <TableCell label="Path">
                        <span className="mono">{verification.requestedBy.kind}</span>
                      </TableCell>
                      <TableCell label="Coverage">
                        <span className="cell-sub">—</span>
                      </TableCell>
                      <TableCell label="Created" className="cell-sub">
                        <Timestamp value={verification.createdAt} />
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
