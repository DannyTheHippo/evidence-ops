import { useEffect, useState } from 'react';
import { listConflicts, type Answer } from '../api/client';
import type { ConflictChunkResolution } from '../components/AnswerView';
import { resolveDocumentVersions, type ResolvedVersion } from './document-index';

interface AnswerEnrichment {
  documentIndex: Map<string, ResolvedVersion>;
  conflictChunkIndex: Map<string, ConflictChunkResolution>;
}

/**
 * Resolves the two display enrichments a completed answer needs beyond what the answer payload
 * itself carries: citation/conflict-value document titles, and — for `conflicting_evidence` —
 * each compared value's source chunk resolved to a document version and locator. Shared by
 * AnswerComposer's live view and AnswerDetailPage's historical view, which both render the same
 * `AnswerView`.
 *
 * Neither resolution can fail the caller — see `document-index.ts`'s own doc comment — so both
 * effects swallow their own rejection and leave the caller with whatever it already had.
 */
export function useAnswerEnrichment(answer: Answer | null): AnswerEnrichment {
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  const [conflictChunkIndex, setConflictChunkIndex] = useState<
    Map<string, ConflictChunkResolution>
  >(new Map());

  // Narrowed to this answer's conflictIds; listConflicts({ limit: 100 }) is the API's max page
  // size, so a chunk belonging to a conflict past the first 100 falls back to its raw
  // sourceChunkId in AnswerView — acceptable at demo scale, upgradeable to server-side enrichment
  // without changing this contract.
  useEffect(() => {
    if (answer?.runStatus !== 'completed' || answer.outcome?.kind !== 'conflicting_evidence')
      return;
    if (answer.conflictIds.length === 0) return;
    let cancelled = false;

    listConflicts({ limit: 100 })
      .then(({ docs }) => {
        if (cancelled) return;
        const index = new Map<string, ConflictChunkResolution>();
        for (const conflict of docs) {
          if (!answer.conflictIds.includes(conflict.id)) continue;
          for (const value of conflict.values) {
            index.set(value.sourceChunkId, {
              documentVersionId: value.documentVersionId,
              locator: value.locator,
            });
          }
        }
        setConflictChunkIndex(index);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [answer?.runStatus, answer?.outcome, answer?.conflictIds]);

  // Version ids come from the citations an `answered`/`insufficient_evidence` outcome carries
  // directly, plus — for `conflicting_evidence` — the document versions the chunk-resolution
  // effect above discovers via `sourceChunkId`. The latter only exist once `conflictChunkIndex`
  // has populated, which is why this effect also runs on that state rather than on the answer
  // alone.
  useEffect(() => {
    if (answer?.runStatus !== 'completed') return;
    const versionIds = [
      ...answer.citations.map((citation) => citation.docVersionId),
      ...Array.from(conflictChunkIndex.values(), (resolution) => resolution.documentVersionId),
    ];
    if (versionIds.length === 0) return;
    let cancelled = false;

    resolveDocumentVersions(versionIds)
      .then((index) => {
        if (!cancelled) setDocumentIndex(index);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [answer?.runStatus, answer?.citations, conflictChunkIndex]);

  return { documentIndex, conflictChunkIndex };
}
