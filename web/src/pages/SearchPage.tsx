import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, searchEvidence, type RetrievedChunkView, type WithCount } from '../api/client';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Skeleton from '../components/ui/Skeleton';
import { buildDocumentVersionIndex, type ResolvedVersion } from '../lib/document-index';
import { formatLocator } from '../lib/locator';

const QUERY_MAX_LENGTH = 500;
const RATE_LIMIT_MESSAGE =
  'Search is limited to 10 queries per minute — each search spends a live embedding call. Wait a moment, then try again.';

function truncateSha256(sha256: string): string {
  return `${sha256.slice(0, 8)}…${sha256.slice(-4)}`;
}

interface ResultRowProps {
  chunk: RetrievedChunkView;
  resolved?: ResolvedVersion;
}

// `EvidenceChunk._id` is content-addressed — derived from the tenant, the version's sha256, an
// ordinal and the locator — so the chip states a hash of the verified bytes plus the id it
// produced, full values on hover, matching the trace-chip treatment `ProvenanceRail` uses for
// answer citations.
function ResultRow({ chunk, resolved }: ResultRowProps) {
  const label = `${truncateSha256(chunk.sha256)} · ${chunk.chunkId}`;
  const title = `sha256 ${chunk.sha256} · chunk ${chunk.chunkId}`;

  return (
    <li className="citation">
      <blockquote className="citation-quote">{chunk.text}</blockquote>
      <p className="citation-locator mono">{formatLocator(chunk.locator)}</p>
      {resolved ? (
        <Link to={`/documents/${resolved.documentId}`} className="trace-chip mono" title={title}>
          {label}
        </Link>
      ) : (
        <span className="trace-chip mono" title={title}>
          {label}
        </span>
      )}
    </li>
  );
}

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WithCount<RetrievedChunkView> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const found = await searchEvidence(query);
      setResults(found);
    } catch (err: unknown) {
      setResults(null);
      if (err instanceof ApiError && err.status === 429) {
        setError(RATE_LIMIT_MESSAGE);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to search evidence');
      }
    } finally {
      setLoading(false);
    }
  }

  // Resolves result document titles/links once there is something to resolve, the same one-call
  // pattern AskPage and ConflictsPage use for citation and conflict-value resolution — one
  // `buildDocumentVersionIndex()` call per search, never per hit. Failure here must not affect
  // result rendering — see document-index.ts.
  useEffect(() => {
    if (!results || results.docs.length === 0) return;
    let cancelled = false;

    buildDocumentVersionIndex()
      .then((index) => {
        if (!cancelled) setDocumentIndex(index);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [results]);

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Evidence</span>
          <h1 className="page-title">Search</h1>
          <p className="page-sub">Find documents and passages across the data room.</p>
        </div>
      </div>

      <section className="card">
        <form onSubmit={(e) => void handleSubmit(e)} className="form">
          <Field
            label="Search query"
            hint={`Up to ${QUERY_MAX_LENGTH} characters. Matches by meaning as well as by keyword.`}
          >
            {(inputProps) => (
              <input
                type="search"
                required
                maxLength={QUERY_MAX_LENGTH}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. cap rate for Northgate Business Park"
                {...inputProps}
              />
            )}
          </Field>
          <div className="form-actions">
            <Button type="submit" disabled={loading}>
              {loading ? 'Searching…' : 'Search'}
            </Button>
          </div>
        </form>
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {loading && <Skeleton label="Searching evidence…" />}

      {!loading && !error && results === null && (
        <EmptyState
          title="Search the evidence corpus"
          description="Find passages by meaning as well as by keyword — try a question or a phrase, not just an exact term. Each search spends a live lookup, so results only appear once you submit."
        />
      )}

      {!loading && !error && results !== null && results.docs.length === 0 && (
        <EmptyState
          title="No results"
          description="Nothing matched that search. Try rewording it or using different terms."
        />
      )}

      {!loading && !error && results !== null && results.docs.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Results</h2>
            <p className="card-meta">{results.count}</p>
          </div>
          <ul className="citations">
            {results.docs.map((chunk) => (
              <ResultRow
                key={chunk.chunkId}
                chunk={chunk}
                resolved={documentIndex.get(chunk.docVersionId)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
