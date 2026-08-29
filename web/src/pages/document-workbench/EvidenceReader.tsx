import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listVersionChunks, type EvidenceChunkView } from '../../api/client';
import CopyButton from '../../components/ui/CopyButton';
import Input from '../../components/ui/Input';
import Skeleton from '../../components/ui/Skeleton';
import { truncateSha256 } from '../../lib/identifiers';
import { formatLocator, locatorGroupKey, locatorGroupLabel, pdfPageOf } from '../../lib/locator';

interface ChunkGroup {
  key: string;
  label: string;
  chunks: EvidenceChunkView[];
}

// Preserves the order chunks arrive in — the API returns them in ingestion order, so the first
// chunk of a given group also fixes that group's position in the outline.
function groupChunks(chunks: EvidenceChunkView[]): ChunkGroup[] {
  const groups: ChunkGroup[] = [];
  const byKey = new Map<string, ChunkGroup>();
  for (const chunk of chunks) {
    const key = locatorGroupKey(chunk.locator);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: locatorGroupLabel(chunk.locator), chunks: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.chunks.push(chunk);
  }
  return groups;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "1 chunk" or "N chunks" — shared by a group's own count and the search status line so the two
 * never drift into different pluralization rules. */
function chunkCountLabel(count: number): string {
  return `${count} chunk${count === 1 ? '' : 's'}`;
}

// Wraps every case-insensitive occurrence of `query` in `text` with a `<mark>`, matching
// SearchPage's own result highlighting. Renders `text` unchanged for an empty or whitespace-only
// query.
function highlightMatches(text: string, query: string): ReactNode {
  const trimmed = query.trim();
  if (trimmed.length === 0) return text;
  const pattern = new RegExp(`(${escapeRegExp(trimmed)})`, 'gi');
  return text.split(pattern).map((part, index) =>
    part.toLowerCase() === trimmed.toLowerCase() ? (
      <mark key={index} className="search-highlight">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

interface EvidenceChunkItemProps {
  chunk: EvidenceChunkView;
  query: string;
  isTarget: boolean;
}

function EvidenceChunkItem({ chunk, query, isTarget }: EvidenceChunkItemProps) {
  const itemRef = useRef<HTMLLIElement | null>(null);

  // Runs once the targeted chunk's group has opened and its element exists. Scrolling first and
  // focusing second lands a screen reader on the passage itself rather than on the group it
  // opened inside.
  useEffect(() => {
    if (!isTarget) return;
    const el = itemRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus();
  }, [isTarget]);

  const locatorLabel = formatLocator(chunk.locator);

  return (
    <li
      ref={itemRef}
      className="evidence-chunk"
      tabIndex={-1}
      aria-current={isTarget ? 'location' : undefined}
    >
      <p className="apparatus-locator mono">{locatorLabel}</p>
      <p className="evidence-chunk-text">{highlightMatches(chunk.text, query)}</p>
      <div className="form-actions">
        <CopyButton
          text={`${locatorLabel}: "${chunk.text}"`}
          label="Copy citation (display text)"
        />
      </div>
    </li>
  );
}

interface EvidenceReaderProps {
  versionId: string;
  // 'reading' widens the measure and line-height for sustained reading — the primary surface for
  // every non-PDF source kind. 'rail' is the unchanged, denser layout for the sidebar beside a PDF
  // pane. Defaults to 'rail', matching this component's shape before either variant existed.
  variant?: 'reading' | 'rail';
  // Reports the PDF page the `?chunk=` target resolves to, so the caller can jump its own PDF
  // pane there — `null` once the target is known not to be a `pdf-page` locator, or once there is
  // no target at all. Omitted entirely by a non-PDF caller, which has no PDF pane to jump.
  onTargetPageChange?: (page: number | null) => void;
}

/**
 * The evidence chunk reader for a document version: every stored chunk, grouped into the
 * document's own structure — page, sheet, heading or slide — as a collapsible outline. Serves two
 * roles in the workbench: the detail rail beside the PDF pane, and the primary reading surface for
 * every non-PDF source kind, which has no inline byte preview to fall back to.
 */
export default function EvidenceReader({
  versionId,
  variant = 'rail',
  onTargetPageChange,
}: EvidenceReaderProps) {
  const [searchParams] = useSearchParams();
  const targetChunkId = searchParams.get('chunk') ?? undefined;

  const [chunks, setChunks] = useState<EvidenceChunkView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [committedVersionId, setCommittedVersionId] = useState(versionId);

  // Adjusts state directly during render rather than in an effect — the sanctioned pattern for
  // resetting derived state when a prop changes (react.dev/learn/you-might-not-need-an-effect),
  // matching `useObjectUrl`'s `committedKey` — so a `versionId` change clears the previous
  // version's chunks/error in the same render pass instead of a stale reader flashing for one
  // extra render.
  if (versionId !== committedVersionId) {
    setCommittedVersionId(versionId);
    setChunks(null);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;

    listVersionChunks(versionId)
      .then((result) => {
        if (!cancelled) setChunks(result.docs);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load evidence chunks');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [versionId]);

  const targetChunk = chunks?.find((chunk) => chunk.id === targetChunkId);

  useEffect(() => {
    onTargetPageChange?.(targetChunk ? pdfPageOf(targetChunk.locator) : null);
  }, [targetChunk, onTargetPageChange]);

  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }

  if (!chunks) {
    return <Skeleton label="Loading evidence…" />;
  }

  const groups = groupChunks(chunks);
  const firstGroupKey = groups[0]?.key;
  const targetGroupKey = targetChunk ? locatorGroupKey(targetChunk.locator) : undefined;

  const trimmedQuery = query.trim();
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      chunks: group.chunks.filter((chunk) =>
        chunk.text.toLowerCase().includes(trimmedQuery.toLowerCase()),
      ),
    }))
    .filter((group) => group.chunks.length > 0);
  const matchCount = visibleGroups.reduce((total, group) => total + group.chunks.length, 0);

  // Exactly one of the two ever renders — a search either turned up something to report a count
  // for, or it did not, never both at once.
  const searchStatus =
    groups.length === 0 || trimmedQuery.length === 0
      ? null
      : visibleGroups.length === 0
        ? `No chunks match “${trimmedQuery}”.`
        : `${chunkCountLabel(matchCount)} match${matchCount === 1 ? 'es' : ''}`;

  return (
    <div className={`evidence-reader evidence-reader--${variant}`}>
      <Input
        label="Search this document"
        placeholder="Search chunk text…"
        value={query}
        onChange={setQuery}
      />

      {targetChunkId !== undefined && !targetChunk && (
        <p className="notice notice--warn">
          The linked passage (chunk {truncateSha256(targetChunkId)}) is not part of this
          version&apos;s stored evidence — it may have moved or been re-ingested. This is still the
          right document version; the specific passage just could not be located.
        </p>
      )}

      {groups.length === 0 && (
        <p className="cell-sub">No evidence chunks are stored for this version.</p>
      )}

      {searchStatus && (
        <p className="cell-sub" role="status" aria-live="polite">
          {searchStatus}
        </p>
      )}

      {visibleGroups.map((group) => (
        <details
          key={group.key}
          className="evidence-group"
          open={group.key === firstGroupKey || group.key === targetGroupKey}
        >
          <summary>
            <span>{group.label}</span>
            <span className="mono">{chunkCountLabel(group.chunks.length)}</span>
          </summary>
          <ul className="evidence-chunk-list" role="list">
            {group.chunks.map((chunk) => (
              <EvidenceChunkItem
                key={chunk.id}
                chunk={chunk}
                query={query}
                isTarget={chunk.id === targetChunk?.id}
              />
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
