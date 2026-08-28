import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDocumentVersions } from './document-index';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function lookupRow(versionId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    versionId,
    documentId: `doc-${versionId}`,
    documentTitle: `Title for ${versionId}`,
    versionNumber: 1,
    sourceKind: 'pdf',
    withdrawn: false,
    ...overrides,
  };
}

describe('resolveDocumentVersions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves each requested id to its document', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/documents/versions/lookup?versionIds=docver-1%2Cdocver-2') {
        return Promise.resolve(
          jsonResponse({ docs: [lookupRow('docver-1'), lookupRow('docver-2')], count: 2 }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const index = await resolveDocumentVersions(['docver-1', 'docver-2']);

    expect(index.get('docver-1')).toEqual({
      documentId: 'doc-docver-1',
      documentTitle: 'Title for docver-1',
      withdrawn: false,
      sourceKind: 'pdf',
    });
    expect(index.get('docver-2')).toEqual({
      documentId: 'doc-docver-2',
      documentTitle: 'Title for docver-2',
      withdrawn: false,
      sourceKind: 'pdf',
    });
  });

  it('leaves an id the endpoint could not resolve absent from the map, rather than throwing', async () => {
    const fetchMock = vi.fn(() =>
      // Only 'docver-1' comes back — 'docver-missing' is unknown/cross-tenant/malformed, and the
      // endpoint drops it from `docs` rather than 404ing.
      Promise.resolve(jsonResponse({ docs: [lookupRow('docver-1')], count: 1 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const index = await resolveDocumentVersions(['docver-1', 'docver-missing']);

    expect(index.get('docver-1')).toBeDefined();
    expect(index.has('docver-missing')).toBe(false);
    expect(index.get('docver-missing')).toBeUndefined();
  });

  it('carries withdrawn onto the resolved shape', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ docs: [lookupRow('docver-1', { withdrawn: true })], count: 1 }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const index = await resolveDocumentVersions(['docver-1']);

    expect(index.get('docver-1')?.withdrawn).toBe(true);
  });

  it('resolves more than 20 distinct documents in one call', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `docver-${i}`);
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ docs: ids.map((id) => lookupRow(id)), count: ids.length })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const index = await resolveDocumentVersions(ids);

    expect(index.size).toBe(25);
    // The 21st id resolves like every other one — a page-size cap anywhere in the path would drop it.
    expect(index.get('docver-20')).toEqual({
      documentId: 'doc-docver-20',
      documentTitle: 'Title for docver-20',
      withdrawn: false,
      sourceKind: 'pdf',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns an empty map without fetching when given no ids', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const index = await resolveDocumentVersions([]);

    expect(index.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dedupes repeated ids into a single request', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/documents/versions/lookup?versionIds=docver-1') {
        return Promise.resolve(jsonResponse({ docs: [lookupRow('docver-1')], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    await resolveDocumentVersions(['docver-1', 'docver-1', 'docver-1']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
