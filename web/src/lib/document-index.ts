import { lookupDocumentVersions, type DocumentSourceKind } from '../api/client';

// The lookup endpoint takes the id list as a single query string; a citation set past this size
// (a document with many conflicts, or a search page's whole result set) chunks into multiple
// calls instead of losing every title to one oversized request.
const LOOKUP_BATCH_SIZE = 100;

export interface ResolvedVersion {
  documentId: string;
  documentTitle: string;
  // Whether the document version currently carries withdrawnAt — the source file behind a
  // resolved citation is no longer at its origin, even though the citation itself stays genuine.
  withdrawn: boolean;
  // The document's own file kind — distinct from a citation's locator kind, which a csv/tsv
  // extractor may record as `text-block` rather than a spreadsheet-shaped locator. Optional so a
  // caller building this map by hand (existing component tests) is not forced to supply it.
  sourceKind?: DocumentSourceKind;
}

/**
 * Resolves a set of `docVersionId`s — from citations, conflict values, or search hits — to the
 * document each belongs to, via the batch lookup endpoint, chunked at `LOOKUP_BATCH_SIZE` ids per
 * call and merged back into one map. An id that does not resolve (unknown, cross-tenant, or
 * malformed) is absent from the result map rather than throwing: callers must treat a missing
 * entry as normal (an unresolved title/link), not an error, matching `lookupDocumentVersions`'s
 * own contract — this is a display enrichment, not something citation rendering depends on.
 */
export async function resolveDocumentVersions(
  versionIds: string[],
): Promise<Map<string, ResolvedVersion>> {
  const index = new Map<string, ResolvedVersion>();
  const uniqueIds = [...new Set(versionIds)];
  if (uniqueIds.length === 0) return index;

  const batches: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += LOOKUP_BATCH_SIZE) {
    batches.push(uniqueIds.slice(i, i + LOOKUP_BATCH_SIZE));
  }

  const results = await Promise.all(batches.map((batch) => lookupDocumentVersions(batch)));
  for (const { docs } of results) {
    for (const doc of docs) {
      index.set(doc.versionId, {
        documentId: doc.documentId,
        documentTitle: doc.documentTitle,
        withdrawn: doc.withdrawn,
        sourceKind: doc.sourceKind,
      });
    }
  }
  return index;
}
