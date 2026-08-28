import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
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
import { IconSearch } from '../components/icons';
import { workbenchHref } from '../lib/citation-link';
import { truncateSha256 } from '../lib/identifiers';
import { formatLocator } from '../lib/locator';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE = 20;
const QUERY_MAX_LENGTH = 500;
const RATE_LIMIT_MESSAGE =
  'Search is limited to 10 queries per minute — each search spends a live embedding call. Wait up to a minute, then try again.';
// Matches the throttle window `RATE_LIMIT_MESSAGE` describes. The API does not hand back a
// Retry-After value this client can read, so the countdown re-arms submission after the whole
// window rather than the (possibly shorter) time actually left in it.
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
// query never reaches this — the field is `required` — but an already-rendered result must not
// crash if it ever does).
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

interface ResultRowProps {
  chunk: RetrievedChunkView;
  query: string;
}

// `EvidenceChunk._id` is content-addressed — derived from the tenant, the version's sha256, an
// ordinal and the locator — so the chip states a hash of the verified bytes plus the id it
// produced, full values on hover, matching the trace-chip treatment `ProvenanceRail` uses for
// answer citations. The chip links into the workbench at this exact chunk rather than the plain
// document page, so a reader lands on the passage instead of having to relocate it.
function ResultRow({ chunk, query }: ResultRowProps) {
  const label = `${truncateSha256(chunk.sha256)} · ${truncateSha256(chunk.chunkId)}`;
  const title = `sha256 ${chunk.sha256} · chunk ${chunk.chunkId}`;

  return (
    <li className="citation">
      <blockquote className="citation-quote">{highlightMatches(chunk.text, query)}</blockquote>
      <p className="citation-locator mono">{formatLocator(chunk.locator)}</p>
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

  const [results, setResults] = useState<SearchEvidenceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // >0 while a 429 cools down; blocks every submission path below, not just the query form's own
  // button, since a filter re-apply or a page turn spends the same rate-limited call.
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  useEffect(() => {
    if (cooldownSeconds === 0) return;
    const timer = setTimeout(() => setCooldownSeconds((seconds) => seconds - 1), 1000);
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
          setCooldownSeconds(RATE_LIMIT_WINDOW_SECONDS);
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

  function commitFilters(sourceClass: string, createdAfter: string, createdBefore: string) {
    if (cooldownSeconds > 0) return;
    beginFetch(urlState.query);
    setUrlState({ sourceClass, createdAfter, createdBefore, skip: URL_DEFAULTS.skip });
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (cooldownSeconds > 0) return;
    beginFetch(draftQuery);
    setUrlState({
      query: draftQuery,
      sourceClass: draftSourceClass,
      createdAfter: draftCreatedAfter,
      createdBefore: draftCreatedBefore,
      skip: URL_DEFAULTS.skip,
    });
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
          };
  } else if (results.docs.length === 0) {
    status = {
      kind: 'empty',
      icon: <IconSearch size={24} />,
      title: 'No results',
      description: 'Nothing matched that search. Try rewording it or using different terms.',
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
          <section className="card">
            <form onSubmit={handleSubmit} className="form">
              <Field
                label="Search query"
                hint={`Up to ${QUERY_MAX_LENGTH} characters. Matches by meaning as well as by keyword.`}
              >
                {(inputProps) => (
                  <input
                    type="search"
                    required
                    maxLength={QUERY_MAX_LENGTH}
                    value={draftQuery}
                    onChange={(e) => setDraftQuery(e.target.value)}
                    placeholder="e.g. cap rate for Northgate Business Park"
                    {...inputProps}
                  />
                )}
              </Field>
              <div className="form-actions">
                <Button type="submit" disabled={loading || cooldownSeconds > 0}>
                  {loading
                    ? 'Searching…'
                    : cooldownSeconds > 0
                      ? `Wait ${cooldownSeconds}s`
                      : 'Search'}
                </Button>
              </div>
            </form>
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
        results !== null && (
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
              Next
            </Button>
          </div>
        )
      }
    >
      {results && results.docs.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Results</h2>
            {/* The count on this page, never a total — the endpoint returns hasMore, not a
                count, because paging over a fused, filtered, over-fetched result set has no
                stable total to report. */}
            <p className="card-meta">
              {results.docs.length} on this page{results.hasMore ? ' · more available' : ''}
            </p>
          </div>
          {groupByDocument(results.docs).map((group) => (
            <div key={group.documentId} className="search-result-group">
              <h3 className="search-result-group-title">
                <Link to={`/documents/${group.documentId}`}>{group.documentTitle}</Link>
              </h3>
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
