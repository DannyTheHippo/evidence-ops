import { useState } from 'react';
import {
  documentVersionContentUrl,
  listVersionChunks,
  type DocumentVersion,
  type DocumentVersionIngestionStatus,
  type EvidenceChunkView,
} from '../../api/client';
import Badge, { type BadgeTone } from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Skeleton from '../../components/ui/Skeleton';
import { TableCell } from '../../components/ui/Table';
import { IconDownload } from '../../components/icons';
import { truncateSha256 } from '../../lib/identifiers';
import { formatBytes } from './format-size';

// 'needs-ocr' and 'facts-failed' carry the same 'caution' tone as 'pending', each deliberately: a
// scanned PDF with no text layer is a gap in the corpus to flag for attention, and a 'facts-failed'
// version has real, citable chunks and only lacks extracted facts. Neither is the
// verification-grade failure 'rejected' signals elsewhere in this app. A total map rather than a
// fallthrough, so a status added to the API's union fails the type-check here instead of silently
// inheriting a tone nobody chose for it.
const INGESTION_TONE: Record<DocumentVersionIngestionStatus, BadgeTone> = {
  pending: 'caution',
  completed: 'verified',
  'facts-failed': 'caution',
  failed: 'rejected',
  'needs-ocr': 'caution',
};

// `listVersionChunks` has no `skip`/`limit` and returns every chunk in one response — the drill-in
// renders straight from that array, never a fetch page. At ~700 tokens of prose each, a card per
// chunk is what actually costs DOM weight, so the cap below bounds cards mounted at once rather
// than bytes transferred.
const CHUNK_PREVIEW_LIMIT = 20;

/** One version row in `DocumentDetail`'s version table, plus its own expandable chunk drill-in —
 * chunks are fetched lazily on first expand and cached in state, so collapsing and re-expanding
 * never re-fetches. */
export default function VersionRow({ version }: { version: DocumentVersion }) {
  const [chunks, setChunks] = useState<EvidenceChunkView[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllChunks, setShowAllChunks] = useState(false);

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
        <TableCell label="Version" className="num">
          v{version.versionNumber}
        </TableCell>
        <TableCell label="Size" className="num">
          {formatBytes(version.sizeBytes)}
        </TableCell>
        <TableCell label="Ingestion">
          <Badge tone={INGESTION_TONE[version.ingestionStatus]}>{version.ingestionStatus}</Badge>
          {version.ingestionFailureReason && (
            <p className="cell-sub">{version.ingestionFailureReason}</p>
          )}
          {/* Silent on an empty array. A reader deciding whether to trust this version — or a
              citation drawn from it — needs to know the text behind it is only part of what the
              source said, and that qualification stands alongside a 'completed' status rather
              than replacing it. */}
          {version.reducedFidelityReasons.length > 0 && (
            <>
              <Badge tone="caution">reduced fidelity</Badge>
              <ul className="fidelity-list">
                {version.reducedFidelityReasons.map((reason) => (
                  <li key={reason} className="cell-sub">
                    {reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </TableCell>
        {/* The full digest is the chain-of-custody value, but 64 hex characters crowd out the
            rest of the row — head and tail on screen, whole value on hover. */}
        <TableCell label="sha256" className="cell-sub mono">
          <span title={version.sha256}>{truncateSha256(version.sha256)}</span>
        </TableCell>
        <TableCell label="Actions" className="cell-actions">
          <div className="form-actions">
            <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={toggleChunks}>
              {expanded ? 'Hide chunks' : 'View chunks'}
            </Button>
            <a className="btn btn--secondary btn--sm" href={documentVersionContentUrl(version.id)}>
              <IconDownload />
              Download
            </a>
          </div>
        </TableCell>
      </tr>
      {expanded && (
        <tr>
          <TableCell colSpan={5}>
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
              <>
                <ul className="chunk-list">
                  {(showAllChunks ? chunks : chunks.slice(0, CHUNK_PREVIEW_LIMIT)).map((chunk) => (
                    <li key={chunk.id} className="card card--narrow">
                      <p className="cell-sub">
                        {chunk.locator.kind} · {chunk.tokenCount} tokens
                      </p>
                      <p>{chunk.text}</p>
                    </li>
                  ))}
                </ul>
                {chunks.length > CHUNK_PREVIEW_LIMIT && (
                  <div className="pager">
                    {!showAllChunks && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setShowAllChunks(true)}
                      >
                        Show all {chunks.length} chunks
                      </Button>
                    )}
                    <span className="cell-sub">
                      Showing {showAllChunks ? chunks.length : CHUNK_PREVIEW_LIMIT} of{' '}
                      {chunks.length} chunks
                    </span>
                  </div>
                )}
              </>
            )}
          </TableCell>
        </tr>
      )}
    </>
  );
}
