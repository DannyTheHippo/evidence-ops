import { useState } from 'react';
import {
  documentVersionContentUrl,
  listVersionChunks,
  type DocumentVersion,
  type DocumentVersionIngestionStatus,
  type EvidenceChunkView,
} from '../../api/client';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Skeleton from '../../components/ui/Skeleton';

function ingestionTone(
  status: DocumentVersionIngestionStatus,
): 'verified' | 'caution' | 'rejected' {
  if (status === 'completed') return 'verified';
  if (status === 'failed') return 'rejected';
  return 'caution';
}

/** One version row in `DocumentDetail`'s version table, plus its own expandable chunk drill-in —
 * chunks are fetched lazily on first expand and cached in state, so collapsing and re-expanding
 * never re-fetches. */
export default function VersionRow({ version }: { version: DocumentVersion }) {
  const [chunks, setChunks] = useState<EvidenceChunkView[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleChunks() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (chunks || loading) return;
    setLoading(true);
    setError(null);
    listVersionChunks(version.id)
      .then(({ docs }) => setChunks(docs))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load chunks');
      })
      .finally(() => setLoading(false));
  }

  return (
    <>
      <tr>
        <td className="num">v{version.versionNumber}</td>
        <td>
          <Badge tone={ingestionTone(version.ingestionStatus)}>{version.ingestionStatus}</Badge>
          {version.ingestionFailureReason && (
            <p className="cell-sub">{version.ingestionFailureReason}</p>
          )}
        </td>
        <td className="cell-sub mono">{version.sha256}</td>
        <td className="cell-actions">
          <div className="form-actions">
            <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={toggleChunks}>
              {expanded ? 'Hide chunks' : 'View chunks'}
            </Button>
            <a className="btn btn--secondary btn--sm" href={documentVersionContentUrl(version.id)}>
              Download
            </a>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4}>
            {loading && <Skeleton label="Loading chunks…" lines={2} />}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {chunks && chunks.length === 0 && (
              <p className="cell-sub">No chunks for this version.</p>
            )}
            {chunks && chunks.length > 0 && (
              <ul className="chunk-list">
                {chunks.map((chunk) => (
                  <li key={chunk.id} className="card card--narrow">
                    <p className="cell-sub">
                      {chunk.locator.kind} · {chunk.tokenCount} tokens
                    </p>
                    <p>{chunk.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
