/**
 * The document workbench's deep-link scheme, so no call site hand-assembles the URL. `chunkId`
 * rides the query string as `chunk`, never the fragment — the fragment is already the invitation
 * link's convention for keeping a credential out of proxy and access logs, and reusing it here
 * would collide with that guarantee.
 */
export function workbenchHref({
  documentId,
  versionId,
  chunkId,
}: {
  documentId: string;
  versionId: string;
  chunkId?: string;
}): string {
  const base = `/documents/${documentId}/versions/${versionId}`;
  if (!chunkId) return base;
  return `${base}?${new URLSearchParams({ chunk: chunkId }).toString()}`;
}
