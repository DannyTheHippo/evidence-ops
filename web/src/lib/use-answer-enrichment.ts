import { useEffect, useState } from 'react';
import { listConflicts, type Answer } from '../api/client';
import type { ConflictChunkResolution } from '../components/AnswerView';
import { resolveDocumentVersions, type ResolvedVersion } from './document-index';

interface AnswerEnrichment {
  documentIndex: Map<string, ResolvedVersion>;
  conflictChunkIndex: Map<string, ConflictChunkResolution>;
}

// `ListConflictsRequestDto.ids` carries the same `@ArrayMaxSize(MAX_PAGINATION_LIMIT)` as every
// other list endpoint's page size, so a single answer touching more conflicts than that would
// otherwise fail the whole request rather than resolve the first batch — chunked and merged the
// same way `resolveDocumentVersions` handles its own id list.
const CONFLICT_LOOKUP_BATCH_SIZE = 100;

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

  useEffect(() => {
    if (answer?.runStatus !== 'completed' || answer.outcome?.kind !== 'conflicting_evidence')
      return;
    if (answer.conflictIds.length === 0) return;
    let cancelled = false;

    const batches: string[][] = [];
    for (let i = 0; i < answer.conflictIds.length; i += CONFLICT_LOOKUP_BATCH_SIZE) {
      batches.push(answer.conflictIds.slice(i, i + CONFLICT_LOOKUP_BATCH_SIZE));
    }

    Promise.all(batches.map((ids) => listConflicts({ ids })))
      .then((results) => {
        if (cancelled) return;
        const index = new Map<string, ConflictChunkResolution>();
        for (const { docs } of results) {
          for (const conflict of docs) {
            for (const value of conflict.values) {
              index.set(value.sourceChunkId, {
                documentVersionId: value.documentVersionId,
                locator: value.locator,
              });
            }
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
