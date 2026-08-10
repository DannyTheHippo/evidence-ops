import { getDocumentById, listDocuments } from '../api/client';

export interface ResolvedVersion {
  documentId: string;
  documentTitle: string;
}

// A citation only carries `docVersionId` — there is no version-to-document lookup endpoint, so
// the index is built client-side from the document list plus one detail fetch per document (each
// detail response is the only place the full version history, and therefore the mapping, lives).
// Callers must treat a missing entry as normal (an unresolved title/link), not an error — this is
// a display enrichment, not something citation rendering depends on.
export async function buildDocumentVersionIndex(): Promise<Map<string, ResolvedVersion>> {
  const index = new Map<string, ResolvedVersion>();
  const { docs } = await listDocuments();
  const details = await Promise.all(docs.map((doc) => getDocumentById(doc.id).catch(() => null)));
  for (const detail of details) {
    if (!detail) continue;
    for (const version of detail.versions) {
      index.set(version.id, { documentId: detail.id, documentTitle: detail.title });
    }
  }
  return index;
}
