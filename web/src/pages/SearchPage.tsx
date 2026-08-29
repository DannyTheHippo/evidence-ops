import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  searchEvidence,
  type DocumentSourceClass,
  type RetrievedChunkView,
  type SearchEvidenceResult,
} from '../api/client';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Button from '../components/ui/Button';
import Field from '../components/ui/Field';
import FilterBar from '../components/ui/FilterBar';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import Timestamp from '../components/ui/Timestamp';
import { IconSearch } from '../components/icons';
import { workbenchHref } from '../lib/citation-link';
import { truncateSha256 } from '../lib/identifiers';
import { formatLocator } from '../lib/locator';
import { useFormSubmit } from '../lib/use-form-submit';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE = 20;
const QUERY_MAX_LENGTH = 500;
const RATE_LIMIT_MESSAGE =
  'Search is limited to 10 queries per minute — each search spends a live embedding call. Wait up to a minute, then try again.';
// Falls back to this whole window only when a 429 carries no Retry-After header — every response
// from the current backend does, so this is a defensive floor, not the expected path.
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Mirrors DocumentSourceClass's literal union (database/schemas/evidence/document/document.schema.ts)
// — client.ts exports the type but not the value set, so the filter enumerates it by hand.
const SOURCE_CLASS_OPTIONS = [
  { value: '', label: 'All source classes' },
  { value: 'crm-export', label: 'crm-export' },
  { value: 'pm-export', label: 'pm-export' },
  { value: 'spreadsheet', label: 'spreadsheet' },
  { value: 'memo', label: 'memo' },
  { value: 'report', label: 'report' },
  { value: 'unclassified', label: 'unclassified' },
];

// Static suggestions, not a recent-query history — a localStorage history would persist tenant
// content unscoped on a shared machine, matching AskPage's own EXAMPLE_QUESTIONS.
const EXAMPLE_QUERIES = [
  'cap rate for Northgate Business Park',
  'Q4 occupancy by property',
  'rent roll for Riverside Center',
];

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both.
const URL_DEFAULTS: Record<
  'query' | 'sourceClass' | 'createdAfter' | 'createdBefore' | 'skip',
  string
> = {
  query: '',
  sourceClass: '',
  createdAfter: '',
  createdBefore: '',
  skip: '0',
};

interface DocumentGroup {
  documentId: string;
  documentTitle: string;
  sourceClass: RetrievedChunkView['sourceClass'];
  documentCreatedAt: string;
  chunks: RetrievedChunkView[];
}

// `results.docs` arrives ranked by fused score, interleaving hits from different documents; this
// regroups them by document while keeping each document's first-seen rank position, since a `Map`
// preserves insertion order.
function groupByDocument(docs: RetrievedChunkView[]): DocumentGroup[] {
  const groups = new Map<string, DocumentGroup>();
  for (const chunk of docs) {
    const group = groups.get(chunk.documentId);
    if (group) {
      group.chunks.push(chunk);
    } else {
      groups.set(chunk.documentId, {
        documentId: chunk.documentId,
        documentTitle: chunk.documentTitle,
        sourceClass: chunk.sourceClass,
        documentCreatedAt: chunk.documentCreatedAt,
        chunks: [chunk],
      });
    }
  }
  return [...groups.values()];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Wraps every occurrence of a query term in `text` with a `<mark>`, case-insensitively. Renders
// `text` unchanged when the query has no terms to match against (an empty or whitespace-only
// query never reaches this — the field is validated before a fetch ever runs — but an
// already-rendered result must not crash if it ever does).
function highlightMatches(text: string, query: string): ReactNode {
  const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
  if (terms.length === 0) return text;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  return text.split(pattern).map((part, index) =>
    terms.includes(part.toLowerCase()) ? (
      <mark key={index} className="search-highlight">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

// `<input type="date">` gives a bare `YYYY-MM-DD`; the endpoint compares against a full instant,
// so a caller-facing "on this day" needs the day's two ends spelled out rather than parsing as
// midnight UTC and excluding the rest of the day.
function startOfDayIso(dateOnly: string): string {
  return `${dateOnly}T00:00:00.000Z`;
}
function endOfDayIso(dateOnly: string): string {
  return `${dateOnly}T23:59:59.999Z`;
}

// mm:ss, floored — the countdown never claims more precision than the one-second tick that
// drives it.
function formatCooldown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

interface AskCrossLinkProps {
  query: string;
}

// Search finds passages; Ask synthesizes an answer over them — this is the one link between the
// two composers, carrying the query text as router state (WCAG 3.3.7's redundant-entry contract)
// rather than a query string, since a query can hold characters a URL would need to encode.
function AskCrossLink({ query }: AskCrossLinkProps) {
  return (
    <Link to="/ask" state={{ questionText: query }} className="search-ask-link">
      Need a synthesized answer? Ask a question →
    </Link>
  );
}

interface ResultRowProps {
  chunk: RetrievedChunkView;
  query: string;
}

// `EvidenceChunk._id` is content-addressed — derived from the tenant, the version's sha256, an
// ordinal and the locator — so the chip states a hash of the verified bytes plus the id it
// produced, full values on hover, matching the trace-chip treatment `ProvenanceRail` uses for
// answer citations. The locator reuses the same `.trace-chip` styling as a plain, non-interactive
// span — the same split `ProvenanceRail`'s own `TraceChip` draws between a resolved and an
// unresolved citation — so a passage carries one chip language, not two. The citation chip links
// into the workbench at this exact chunk rather than the plain document page, so a reader lands on
// the passage instead of having to relocate it.
function ResultRow({ chunk, query }: ResultRowProps) {
  const label = `${truncateSha256(chunk.sha256)} · ${truncateSha256(chunk.chunkId)}`;
  const title = `sha256 ${chunk.sha256} · chunk ${chunk.chunkId}`;

  return (
    <li className="citation">
      <blockquote className="citation-quote">{highlightMatches(chunk.text, query)}</blockquote>
      <div className="search-citation-meta">
        <span className="trace-chip mono">{formatLocator(chunk.locator)}</span>
        <Link
          to={workbenchHref({
            documentId: chunk.documentId,
            versionId: chunk.docVersionId,
            chunkId: chunk.chunkId,
          })}
          className="trace-chip mono"
          title={title}
        >
          {label}
        </Link>
      </div>
    </li>
  );
}

export default function SearchPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const appliedSourceClass = urlState.sourceClass as DocumentSourceClass | '';
  const skip = Number(urlState.skip);

  // Only these, not the controls' own values, drive the fetch — the query and filters apply on
  // submit, never on a keystroke or selection change.
  const [draftQuery, setDraftQuery] = useState(urlState.query);
  const [draftSourceClass, setDraftSourceClass] = useState(appliedSourceClass);
  const [draftCreatedAfter, setDraftCreatedAfter] = useState(urlState.createdAfter);
  const [draftCreatedBefore, setDraftCreatedBefore] = useState(urlState.createdBefore);
  const queryInputRef = useRef<HTMLInputElement>(null);

  const [results, setResults] = useState<SearchEvidenceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // >0 while a 429 cools down; blocks every submission path below, not just the query form's own
  // button, since a filter re-apply or a page turn spends the same rate-limited call.
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  useEffect(() => {
    if (cooldownSeconds === 0) return;
    const timer = setTimeout(() => {
      if (cooldownSeconds === 1) {
        // The alert and the chip are two faces of the same cooldown, so they clear on the same
        // tick rather than leaving a stale alert on screen once the window has actually elapsed.
        setCooldownSeconds(0);
        setError(null);
      } else {
        setCooldownSeconds(cooldownSeconds - 1);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [cooldownSeconds]);

  useEffect(() => {
    if (urlState.query === '') return;

    let cancelled = false;
    searchEvidence({
      query: urlState.query,
      skip,
      limit: PAGE_SIZE,
      sourceClass: appliedSourceClass === '' ? undefined : appliedSourceClass,
      createdAfter: urlState.createdAfter === '' ? undefined : startOfDayIso(urlState.createdAfter),
      createdBefore:
        urlState.createdBefore === '' ? undefined : endOfDayIso(urlState.createdBefore),
    })
      .then((found) => {
        if (cancelled) return;
        setResults(found);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        if (err instanceof ApiError && err.status === 429) {
          setError(RATE_LIMIT_MESSAGE);
          setCooldownSeconds(err.retryAfterSeconds ?? RATE_LIMIT_WINDOW_SECONDS);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to search evidence');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [urlState.query, appliedSourceClass, urlState.createdAfter, urlState.createdBefore, skip]);

  // `loading`/`error` reset here, in the handler that decides a new fetch is about to start,
  // rather than at the top of the effect above — an effect is for synchronizing with the fetch
  // it owns, not for the state a user action already knows it is about to invalidate. A no-op
  // when `query` is empty: nothing will fetch, so nothing should claim to be loading.
  function beginFetch(query: string) {
    if (query === '') return;
    setLoading(true);
    setError(null);
  }

  const { onSubmit, fieldProps } = useFormSubmit<'query'>({
    validate: () => {
      if (!draftQuery.trim()) return { query: 'Enter a search query.' };
      if (draftQuery.length > QUERY_MAX_LENGTH) {
        return { query: `Search query must be ${QUERY_MAX_LENGTH} characters or fewer.` };
      }
      return {};
    },
    // Synchronous: the actual fetch runs in the effect watching `urlState.query`, not here — this
    // only stages the URL state that effect reacts to. `useFormSubmit` still awaits `submit`, so
    // the signature stays `Promise<void>` without an `async` keyword that would have nothing to
    // await.
    submit: () => {
      if (cooldownSeconds > 0) return Promise.resolve();
      beginFetch(draftQuery);
      setUrlState({
        query: draftQuery,
        sourceClass: draftSourceClass,
        createdAfter: draftCreatedAfter,
        createdBefore: draftCreatedBefore,
        skip: URL_DEFAULTS.skip,
      });
      return Promise.resolve();
    },
  });
  const { id: queryId, error: queryError } = fieldProps('query');

  function fillExample(example: string) {
    setDraftQuery(example);
    queryInputRef.current?.focus();
  }

  function commitFilters(sourceClass: string, createdAfter: string, createdBefore: string) {
    if (cooldownSeconds > 0) return;
    beginFetch(urlState.query);
    setUrlState({ sourceClass, createdAfter, createdBefore, skip: URL_DEFAULTS.skip });
  }

  function handleApply() {
    commitFilters(draftSourceClass, draftCreatedAfter, draftCreatedBefore);
  }

  function handleClear() {
    setDraftSourceClass('');
    setDraftCreatedAfter('');
    setDraftCreatedBefore('');
    commitFilters('', '', '');
  }

  function goToPage(nextSkip: number) {
    if (cooldownSeconds > 0) return;
    beginFetch(urlState.query);
    setUrlState({ skip: String(Math.max(0, nextSkip)) });
  }

  const hasFilter =
    appliedSourceClass !== '' || urlState.createdAfter !== '' || urlState.createdBefore !== '';

  let status: RecordListStatus;
  if (results === null) {
    status = error
      ? { kind: 'blank' }
      : loading
        ? { kind: 'loading', label: 'Searching evidence…' }
        : {
            kind: 'empty',
            icon: <IconSearch size={24} />,
            title: 'Search the evidence corpus',
            description:
              'Find passages by meaning as well as by keyword — try a question or a phrase, not just an exact term. Each search spends a live lookup, so results only appear once you submit.',
            // No Ask cross-link here — the composer above already carries the one for every
            // status, pre-search included, so a second copy right below it would say the same
            // thing twice.
            action: (
              <div className="composer-examples">
                {EXAMPLE_QUERIES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="btn btn--sm example-chip"
                    onClick={() => fillExample(example)}
                  >
                    {example}
                  </button>
                ))}
              </div>
            ),
          };
  } else if (results.docs.length === 0) {
    status = {
      kind: 'empty',
      icon: <IconSearch size={24} />,
      title: 'No results',
      description:
        'Nothing matched that search. Try rewording it, using different terms, or clearing a filter.',
      // No Ask cross-link here either — the composer above already carries the one for every
      // status, a zero-result search included, so a second copy right below it would say the
      // same thing twice.
      action: hasFilter ? (
        <Button type="button" variant="secondary" size="sm" onClick={handleClear}>
          Clear filters
        </Button>
      ) : undefined,
    };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Evidence"
      title="Search"
      description="Find documents and passages across the data room."
      filters={
        <>
          {/* Untitled, unlike the filter bar below — the query field is the page's purpose, not
              a refinement of something else, and a heading here would repeat the page title. */}
          <section className="card search-composer">
            <form onSubmit={onSubmit} className="search-composer-row" noValidate>
              <Field
                id={queryId}
                label="Search query"
                hint={`Up to ${QUERY_MAX_LENGTH} characters. Matches by meaning as well as by keyword.`}
                error={queryError}
              >
                {(inputProps) => (
                  <input
                    ref={queryInputRef}
                    type="search"
                    maxLength={QUERY_MAX_LENGTH}
                    value={draftQuery}
                    onChange={(e) => setDraftQuery(e.target.value)}
                    placeholder="e.g. cap rate for Northgate Business Park"
                    {...inputProps}
                  />
                )}
              </Field>
              <div className="search-composer-actions">
                <Button type="submit" disabled={loading || cooldownSeconds > 0}>
                  {loading ? 'Searching…' : 'Search'}
                </Button>
                {cooldownSeconds > 0 && (
                  <span className="search-cooldown-chip mono" aria-hidden="true">
                    {formatCooldown(cooldownSeconds)}
                  </span>
                )}
              </div>
            </form>
            <div className="composer-meta">
              <p className="composer-hint">Search finds passages — it never synthesizes one.</p>
              <AskCrossLink query={draftQuery} />
            </div>
          </section>
          <FilterBar onApply={handleApply} onClear={handleClear} hasFilter={hasFilter}>
            <Select
              label="Source class"
              options={SOURCE_CLASS_OPTIONS}
              value={draftSourceClass}
              onChange={(value) => setDraftSourceClass(value as DocumentSourceClass | '')}
            />
            <Input
              label="Created after"
              type="date"
              value={draftCreatedAfter}
              onChange={setDraftCreatedAfter}
            />
            <Input
              label="Created before"
              type="date"
              value={draftCreatedBefore}
              onChange={setDraftCreatedBefore}
            />
          </FilterBar>
        </>
      }
      error={error ?? undefined}
      status={status}
      footer={
        results !== null &&
        results.docs.length > 0 && (
          <div className="pager">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={skip === 0 || cooldownSeconds > 0}
              onClick={() => goToPage(skip - PAGE_SIZE)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!results.hasMore || cooldownSeconds > 0}
              onClick={() => goToPage(skip + PAGE_SIZE)}
            >
              More results
            </Button>
            {/* Never a total — the endpoint returns hasMore, not a count, because paging over a
                fused, filtered, over-fetched result set has no stable total to report. */}
            <span className="cell-sub mono">
              Showing {skip + 1}–{skip + results.docs.length}
              {results.hasMore ? ' · more available' : ''}
            </span>
          </div>
        )
      }
    >
      {results && results.docs.length > 0 && (
        // Untitled, unlike the pre-redesign card — a "Results" head repeated what the toolbar and
        // page title already say, and the per-group meta line now carries the count instead.
        <section className="card">
          {groupByDocument(results.docs).map((group) => (
            <div key={group.documentId} className="search-result-group">
              <h3 className="search-result-group-title">
                <Link to={`/documents/${group.documentId}`}>{group.documentTitle}</Link>
              </h3>
              <p className="search-result-group-meta">
                <span className="search-result-group-class">{group.sourceClass}</span>
                <Timestamp value={group.documentCreatedAt} />
                <span className="mono">
                  {group.chunks.length} passage{group.chunks.length === 1 ? '' : 's'}
                </span>
              </p>
              <ul className="citations">
                {group.chunks.map((chunk) => (
                  <ResultRow key={chunk.chunkId} chunk={chunk} query={urlState.query} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </RecordListPage>
  );
}
