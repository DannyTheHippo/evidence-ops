import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Answer } from '../api/client';
import { useAnswerEnrichment } from './use-answer-enrichment';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseAnswer: Answer = {
  id: 'answer-1',
  questionText: 'What is the cap rate?',
  runStatus: 'completed',
  citations: [],
  conflictIds: [],
  createdAt: new Date().toISOString(),
  atoms: [],
  withdrawnCitedDocVersionIds: [],
};

describe('useAnswerEnrichment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns empty maps and fetches nothing for a null answer', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAnswerEnrichment(null));

    expect(result.current.documentIndex.size).toBe(0);
    expect(result.current.conflictChunkIndex.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches nothing for a completed answer with no citations and no conflict outcome', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const answer: Answer = {
      ...baseAnswer,
      outcome: { kind: 'insufficient_evidence', reason: 'No evidence.' },
    };

    const { result } = renderHook(() => useAnswerEnrichment(answer));

    expect(result.current.documentIndex.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves the document index for a completed answer carrying citations', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/documents/versions/lookup?versionIds=docver-1') {
        return Promise.resolve(
          jsonResponse({
            docs: [
              {
                versionId: 'docver-1',
                documentId: 'doc-1',
                documentTitle: 'Rent Roll Q1',
                versionNumber: 1,
                sourceKind: 'pdf',
                withdrawn: false,
              },
            ],
            count: 1,
          }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const answer: Answer = {
      ...baseAnswer,
      outcome: { kind: 'answered', claims: [] },
      citations: [
        {
          docVersionId: 'docver-1',
          sha256: 'a'.repeat(64),
          chunkId: 'chunk-a',
          locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
          quote: 'Cap rate: 6.1%',
        },
      ],
    };

    const { result } = renderHook(() => useAnswerEnrichment(answer));

    await waitFor(() => {
      expect(result.current.documentIndex.get('docver-1')).toEqual({
        documentId: 'doc-1',
        documentTitle: 'Rent Roll Q1',
        withdrawn: false,
        sourceKind: 'pdf',
      });
    });
  });

  it('joins conflicts by id rather than reading the first page', async () => {
    const conflicts = {
      docs: [
        {
          id: 'conflict-1',
          factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
          factIds: ['fact-a'],
          values: [
            {
              factId: 'fact-a',
              value: 6.1,
              unit: 'percent',
              sourceChunkId: 'chunk-a',
              documentVersionId: 'docver-1',
              locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
            },
          ],
          magnitude: 0.003,
          status: 'open',
          createdAt: new Date().toISOString(),
        },
      ],
      count: 1,
    };

    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/conflicts?ids=conflict-1')
        return Promise.resolve(jsonResponse(conflicts));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const answer: Answer = {
      ...baseAnswer,
      outcome: {
        kind: 'conflicting_evidence',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        values: [{ value: 6.1, unit: 'percent', sourceChunkId: 'chunk-a' }],
      },
      conflictIds: ['conflict-1'],
    };

    const { result } = renderHook(() => useAnswerEnrichment(answer));

    await waitFor(() => {
      expect(result.current.conflictChunkIndex.get('chunk-a')).toEqual({
        documentVersionId: 'docver-1',
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      });
    });
  });

  it('chunks a conflictIds list past the server page cap into multiple requests', async () => {
    const manyIds = Array.from({ length: 150 }, (_, i) => `conflict-${i}`);
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      requestedUrls.push(url);
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const answer: Answer = {
      ...baseAnswer,
      outcome: {
        kind: 'conflicting_evidence',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        values: [{ value: 6.1, unit: 'percent', sourceChunkId: 'chunk-a' }],
      },
      conflictIds: manyIds,
    };

    renderHook(() => useAnswerEnrichment(answer));

    await waitFor(() => {
      expect(requestedUrls.length).toBe(2);
    });
    expect(new URLSearchParams(requestedUrls[0].split('?')[1]).get('ids')).toBe(
      manyIds.slice(0, 100).join(','),
    );
    expect(new URLSearchParams(requestedUrls[1].split('?')[1]).get('ids')).toBe(
      manyIds.slice(100).join(','),
    );
  });

  it('still renders when the conflict join fails', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('network error')));
    vi.stubGlobal('fetch', fetchMock);

    const answer: Answer = {
      ...baseAnswer,
      outcome: {
        kind: 'conflicting_evidence',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        values: [{ value: 6.1, unit: 'percent', sourceChunkId: 'chunk-a' }],
      },
      conflictIds: ['conflict-1'],
    };

    const { result } = renderHook(() => useAnswerEnrichment(answer));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(result.current.conflictChunkIndex.size).toBe(0);
    expect(result.current.documentIndex.size).toBe(0);
  });
});
