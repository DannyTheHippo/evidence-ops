import { lookupDocumentVersions, type DocumentSourceKind } from '../api/client';

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
 * document each belongs to, via the batch lookup endpoint. An id that does not resolve (unknown,
 * cross-tenant, or malformed) is absent from the result map rather than throwing: callers must
 * treat a missing entry as normal (an unresolved title/link), not an error, matching
 * `lookupDocumentVersions`'s own contract — this is a display enrichment, not something citation
 * rendering depends on.
 */
export async function resolveDocumentVersions(
  versionIds: string[],
): Promise<Map<string, ResolvedVersion>> {
  const index = new Map<string, ResolvedVersion>();
  const uniqueIds = [...new Set(versionIds)];
  if (uniqueIds.length === 0) return index;
  const { docs } = await lookupDocumentVersions(uniqueIds);
  for (const doc of docs) {
    index.set(doc.versionId, {
      documentId: doc.documentId,
      documentTitle: doc.documentTitle,
      withdrawn: doc.withdrawn,
      sourceKind: doc.sourceKind,
    });
  }
  return index;
}
