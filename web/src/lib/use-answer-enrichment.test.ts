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
      });
    });
  });

  it('resolves conflict chunks narrowed to the answer conflictIds, falling back for an unmatched chunk', async () => {
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
        {
          id: 'conflict-2',
          factKey: { entity: 'Other Park', metric: 'cap_rate', period: '2025-03' },
          factIds: ['fact-b'],
          values: [
            {
              factId: 'fact-b',
              value: 7.0,
              unit: 'percent',
              sourceChunkId: 'chunk-b',
              documentVersionId: 'docver-2',
              locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 1 },
            },
          ],
          magnitude: 0.01,
          status: 'open',
          createdAt: new Date().toISOString(),
        },
      ],
      count: 2,
    };

    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/conflicts?limit=100') return Promise.resolve(jsonResponse(conflicts));
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
    // conflict-2 is not in this answer's conflictIds, so its chunk is left unresolved.
    expect(result.current.conflictChunkIndex.get('chunk-b')).toBeUndefined();
  });
});
