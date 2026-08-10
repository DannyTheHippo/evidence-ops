import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DataRoomPage from './DataRoomPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DataRoomPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists documents with their ingestion status, distinguishing pending from completed', async () => {
    const documents = {
      docs: [
        {
          id: 'doc-1',
          title: 'Q3 Rent Roll',
          sourceKind: 'xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          currentVersion: {
            id: 'v-1',
            versionNumber: 1,
            sha256: 'a'.repeat(64),
            sizeBytes: 100,
            ingestionStatus: 'completed',
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        },
        {
          id: 'doc-2',
          title: 'Valuation Memo',
          sourceKind: 'pdf',
          mimeType: 'application/pdf',
          currentVersion: {
            id: 'v-2',
            versionNumber: 1,
            sha256: 'b'.repeat(64),
            sizeBytes: 200,
            ingestionStatus: 'pending',
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        },
      ],
      count: 2,
    };

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(documents));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <DataRoomPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Q3 Rent Roll')).toBeInTheDocument();
    expect(screen.getByText('Valuation Memo')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });
});
