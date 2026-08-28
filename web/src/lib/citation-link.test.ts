import { describe, expect, it } from 'vitest';
import { workbenchHref } from './citation-link';

describe('workbenchHref', () => {
  it('builds the bare document-version route without a chunk', () => {
    expect(workbenchHref({ documentId: 'doc-1', versionId: 'version-1' })).toBe(
      '/documents/doc-1/versions/version-1',
    );
  });

  it('carries a chunk id as a query parameter, never a fragment', () => {
    const href = workbenchHref({ documentId: 'doc-1', versionId: 'version-1', chunkId: 'chunk-1' });

    expect(href).toBe('/documents/doc-1/versions/version-1?chunk=chunk-1');
    expect(href).not.toContain('#');
  });

  it('percent-encodes a chunk id that needs it', () => {
    expect(
      workbenchHref({ documentId: 'doc-1', versionId: 'version-1', chunkId: 'chunk one' }),
    ).toBe('/documents/doc-1/versions/version-1?chunk=chunk+one');
  });
});
