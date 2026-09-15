import { useEffect, useState } from 'react';
import {
  listAnswers,
  listVerifications,
  type Answer,
  type AnswerRunStatus,
  type AnswerSortField,
  type SortDirection,
  type Verification,
} from '../api/client';
import { IconFileText } from '../components/icons';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import DateRange from '../components/ui/DateRange';
import EmptyState from '../components/ui/EmptyState';
import FilterBar from '../components/ui/FilterBar';
import Pager from '../components/ui/Pager';
import Panel from '../components/ui/Panel';
import SegmentedControl from '../components/ui/SegmentedControl';
import Select from '../components/ui/Select';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import Tooltip from '../components/ui/Tooltip';
import { answerBadge } from '../lib/answer-status';
import { verdictTally } from '../lib/answer-verdicts';
import {
  dateRangeKey,
  isDateRangeActive,
  readDateRange,
  toDateRangeInstants,
  writeDateRange,
} from '../lib/date-range';
import { clampPageSize, clampSkip, pickOption } from '../lib/paging';
import { useAbortableEffect } from '../lib/use-latest';
import { useResultAnnouncer } from '../lib/use-result-announcer';
import { useUrlState } from '../lib/use-url-state';
import AnswerComposer from './answers/AnswerComposer';

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [DEFAULT_PAGE_SIZE, 50, 100];

// Matches the server's `@IsIn` list in `list-answers.request.dto.ts`.
const SORT_FIELDS: readonly AnswerSortField[] = ['createdAt', 'runStatus', 'claimCoverage'];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

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

// The fourth column holds a different fact per kind — the route an answer took, and the caller
// that requested a verification — so its header names the fact rather than the position.
const PATH_HEADER: Record<HistoryKind, string> = {
  answers: 'Answer path',
  verifications: 'Requested by',
};

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both. Typed as
// plain `string` fields, not `as const` literals, so the values written back through
// `setUrlState` — themselves unions like `AnswerSortField` — stay assignable.
const URL_DEFAULTS: Record<
  'q' | 'kind' | 'runStatus' | 'range' | 'from' | 'to' | 'limit' | 'sort' | 'sortDir' | 'skip',
  string
> = {
  q: '',
  kind: 'answers',
  runStatus: '',
  range: '',
  from: '',
  to: '',
  limit: String(DEFAULT_PAGE_SIZE),
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
};

export default function AnswersPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const kind = urlState.kind as HistoryKind;
  const appliedRunStatus = urlState.runStatus as AnswerRunStatus | '';
  // A hand-edited or stale `sort`/`sortDir` falls back to the page default rather than reaching
  // the API with a value its `@IsIn` decorator refuses, which would otherwise blank the page.
  const sort = pickOption(urlState.sort, SORT_FIELDS, 'createdAt');
  const sortDir = pickOption(urlState.sortDir, SORT_DIRECTIONS, 'desc');
  const skip = clampSkip(urlState.skip);
  const pageSize = clampPageSize(urlState.limit, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE);
  const dateRange = readDateRange(urlState);
  // `''` while the range filters nothing, so revealing an empty Custom range neither refetches nor
  // announces; the `DateRange` change handler below resets `skip` on the same key, so it stays put
  // too.
  const dateKey = dateRangeKey(dateRange);
  const filterKey = JSON.stringify({ kind, runStatus: appliedRunStatus, dateKey });

  const [answers, setAnswers] = useState<Answer[] | null>(null);
  const [verifications, setVerifications] = useState<Verification[] | null>(null);
  // Split so a late response for the other kind can never land on this kind's total — a shared
  // counter would still cross kinds even with the sequence guard below, since a same-kind guard
  // says nothing about which kind a response belongs to.
  const [answersCount, setAnswersCount] = useState(0);
  const [verificationsCount, setVerificationsCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the composer once a run has been seeded or a run it started settles, so the history
  // list refetches — the composer's own submit never navigates away from this page.
  const [reloadKey, setReloadKey] = useState(0);
  const announceResult = useResultAnnouncer();

  useAbortableEffect(
    (isCurrent) => {
      if (kind === 'answers') {
        // Resolved here, not during render: a `24h` range yields a different instant on every call.
        const { from, to } = toDateRangeInstants(dateRange);
        listAnswers({
          skip,
          limit: pageSize,
          runStatus: appliedRunStatus === '' ? undefined : appliedRunStatus,
          sort,
          sortDir,
          from,
          to,
        })
          .then(({ docs, count: total }) => {
            if (!isCurrent()) return;
            setAnswers(docs);
            setAnswersCount(total);
            setError(null);
            announceResult(filterKey, `${total} answer${total === 1 ? '' : 's'}`);
          })
          .catch((err: unknown) => {
            if (!isCurrent()) return;
            setError(err instanceof Error ? err.message : 'Failed to load answers');
          });
      } else {
        listVerifications({ skip, limit: pageSize, sort: 'createdAt', sortDir })
          .then(({ docs, count: total }) => {
            if (!isCurrent()) return;
            setVerifications(docs);
            setVerificationsCount(total);
            setError(null);
            announceResult(filterKey, `${total} verification${total === 1 ? '' : 's'}`);
          })
          .catch((err: unknown) => {
            if (!isCurrent()) return;
            setError(err instanceof Error ? err.message : 'Failed to load verifications');
          });
      }
    },
    [
      kind,
      skip,
      pageSize,
      appliedRunStatus,
      sort,
      sortDir,
      dateKey,
      reloadKey,
      filterKey,
      announceResult,
    ],
  );

  // A rephrase link elsewhere carries `?q=` into this page; the composer adopts it into its draft
  // on render, and this strips it right after so a later reload can't overwrite a newer draft.
  useEffect(() => {
    if (urlState.q) setUrlState({ q: '' });
  }, [urlState.q, setUrlState]);

  function handleClear() {
    setUrlState({ runStatus: '', range: '', from: '', to: '', skip: URL_DEFAULTS.skip });
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
    // Resets only the kind being switched to, and only here — never on a `skip`/`sort`/filter
    // change, which would unmount the still-visible `Pager` mid-click. Without this, switching
    // back to a kind visited earlier in the session would flash that stale page before the fresh
    // fetch lands.
    if (next === 'answers') {
      setAnswers(null);
    } else {
      setVerifications(null);
    }
    // The sort resets with the kind: a `claimCoverage`/`runStatus` sort field carried over from
    // the answers kind would leave the verifications `Created` header reading as inactive. The
    // answer filters reset too — the verifications list takes no run-status or date params, so a
    // filter left in the URL would silently narrow the answers list again on the way back, with
    // the `FilterBar` unmounted and unable to show it.
    setUrlState({
      kind: next,
      runStatus: '',
      range: '',
      from: '',
      to: '',
      skip: URL_DEFAULTS.skip,
      sort: URL_DEFAULTS.sort,
    });
  }

  const hasFilter = kind === 'answers' && (appliedRunStatus !== '' || isDateRangeActive(dateRange));
  const items = kind === 'answers' ? answers : verifications;
  const count = kind === 'answers' ? answersCount : verificationsCount;

  let status: RecordListStatus;
  if (items === null) {
    status = error
      ? { kind: 'blank' }
      : { kind: 'loading', label: `Loading ${kind === 'answers' ? 'answers' : 'verifications'}…` };
  } else if (items.length === 0 && kind === 'verifications') {
    status = {
      kind: 'empty',
      icon: <IconFileText size={24} />,
      title: 'No verifications yet',
      description: 'Runs of verify_claims over MCP appear here.',
    };
  } else {
    // Zero answer rows still resolves to `ready` rather than RecordListPage's own `empty` kind —
    // that kind's EmptyState carries no `className`, and the unfiltered case needs
    // `empty-state--zero` to read as an earned-zero state rather than a filtered-empty one.
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
          onRunSettled={() => setReloadKey((n) => n + 1)}
        />
      }
      view={
        <SegmentedControl<HistoryKind>
          aria-label="History kind"
          options={KIND_OPTIONS}
          value={kind}
          onChange={handleKindChange}
        />
      }
      filters={
        kind === 'answers' && (
          <FilterBar label="Answer filters" onClear={handleClear} hasFilter={hasFilter}>
            <Select
              label="Run status"
              width="sm"
              options={RUN_STATUS_OPTIONS}
              value={appliedRunStatus}
              onChange={(value) => setUrlState({ runStatus: value, skip: URL_DEFAULTS.skip })}
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
        )
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
      {kind === 'answers' && items && items.length === 0 && hasFilter && (
        <EmptyState
          icon={<IconFileText size={24} />}
          title="No answers match this filter"
          description="Clear or adjust the run status or date filter above."
          action={
            <Button variant="secondary" onClick={handleClear}>
              Show all answers
            </Button>
          }
        />
      )}

      {kind === 'answers' && items && items.length === 0 && !hasFilter && (
        <EmptyState
          className="empty-state--zero"
          icon={<IconFileText size={24} />}
          title="No answers yet"
          description="Ask a question above to see it appear here."
        />
      )}

      {items && items.length > 0 && (
        <Panel aria-label="Answers and verifications">
          <Table caption="Answers and verifications with their grounding" className="answers-grid">
            <colgroup>
              <col />
              <col className="col-badge" />
              <col className="col-compact" />
              <col className="col-narrow" />
              <col className="col-narrow" />
            </colgroup>
            <thead>
              <tr>
                <TableHeaderCell>Subject</TableHeaderCell>
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
                <TableHeaderCell>{PATH_HEADER[kind]}</TableHeaderCell>
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
                          <Tooltip content={answer.questionText}>
                            <RowLink to={`/answers/${answer.id}`}>
                              <span className="cell-truncate">{answer.questionText}</span>
                            </RowLink>
                          </Tooltip>
                        </TableCell>
                        <TableCell label="Result">
                          <Badge tone={badge.tone}>{badge.label}</Badge>
                          {answer.withdrawnCitedDocVersionIds.length > 0 && (
                            <Badge tone="caution">citation withdrawn</Badge>
                          )}
                        </TableCell>
                        <TableCell label={PATH_HEADER.answers}>
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
                        <Tooltip content={verification.claims.join(' | ')}>
                          <RowLink to={`/answers/verifications/${verification.id}`}>
                            <span className="cell-truncate">
                              {verification.claims[0]}
                              {verification.claims.length > 1 &&
                                ` +${verification.claims.length - 1} more`}
                            </span>
                          </RowLink>
                        </Tooltip>
                      </TableCell>
                      <TableCell label="Result" className="mono">
                        {verdictTally(verification.results)}
                      </TableCell>
                      <TableCell label={PATH_HEADER.verifications}>
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
