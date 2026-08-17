import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SourceDetailPage from './SourceDetailPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const sourceWithFileStates = {
  id: 'source-1',
  name: 'Deal Room Inbox',
  kind: 'local-folder',
  path: 'deal-room',
  enabled: true,
  lastSyncAt: '2026-08-01T12:00:00.000Z',
  lastSyncStatus: 'failed',
  lastSyncError: 'connector refused an oversized file',
  fileCount: 2,
  createdAt: new Date().toISOString(),
  fileStates: [
    {
      path: 'contracts/lease-agreement.pdf',
      status: 'ok',
      mtimeMs: 1_753_920_000_000,
    },
    {
      path: 'contracts/broken-scan.pdf',
      status: 'failed',
      lastError: "Could not resolve a document type for 'contracts/broken-scan.pdf'",
      mtimeMs: 1_753_920_100_000,
    },
  ],
};

function renderAt(id: string) {
  render(
    <MemoryRouter initialEntries={[`/sources/${id}`]}>
      <Routes>
        <Route path="/sources/:id" element={<SourceDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SourceDetailPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows a loading state before the source arrives', async () => {
    let resolveSource: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSource = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(screen.getByText('Loading…')).toBeInTheDocument();

    resolveSource!(jsonResponse(sourceWithFileStates));

    expect(await screen.findByText('Deal Room Inbox')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('shows a failing file and its error, distinct from an ok file', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sourceWithFileStates));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(await screen.findByText('contracts/lease-agreement.pdf')).toBeInTheDocument();
    expect(screen.getByText('contracts/broken-scan.pdf')).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(
      screen.getByText("Could not resolve a document type for 'contracts/broken-scan.pdf'"),
    ).toBeInTheDocument();
  });

  it('shows "Source not found" for a 404, not the generic error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "Source 'source-1' not found" }, 404));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(await screen.findByText('Source not found.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the load error for a non-404 failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'Source unavailable' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('source-1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Source unavailable');
  });
});
