import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConflictsPage from './ConflictsPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const documentVersion = {
  id: 'docver-1',
  versionNumber: 1,
  sha256: 'abc',
  sizeBytes: 10,
  ingestionStatus: 'completed',
  createdAt: new Date().toISOString(),
};
// Not named `document` — that shadows the jsdom global (see client.ts's own note on
// `EvidenceDocument` for the same hazard).
const documentFixture = {
  id: 'doc-1',
  title: 'Rent Roll Q1',
  sourceKind: 'pdf',
  mimeType: 'application/pdf',
  currentVersion: documentVersion,
  createdAt: new Date().toISOString(),
};

const openConflict = {
  id: 'conflict-1',
  factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
  factIds: ['fact-1', 'fact-2'],
  values: [
    {
      factId: 'fact-1',
      value: 6.1,
      unit: 'percent',
      sourceChunkId: 'chunk-a',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
    },
  ],
  magnitude: 0.0085,
  status: 'open',
  createdAt: new Date().toISOString(),
  proposedWinnerFactId: 'fact-1',
  ruleFired: 'authority',
  explanation: "Source 'chunk-a' outranks the other value's source under the authority policy.",
};

const recencyConflict = {
  ...openConflict,
  id: 'conflict-2',
  proposedWinnerFactId: 'fact-3',
  ruleFired: 'recency',
  explanation: "Source 'chunk-c' was ingested more recently than the conflicting value's source.",
  values: [
    {
      factId: 'fact-3',
      value: 5.4,
      unit: 'percent',
      sourceChunkId: 'chunk-c',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 4 },
    },
  ],
};

const undecidedConflict = {
  ...openConflict,
  id: 'conflict-3',
  proposedWinnerFactId: undefined,
  ruleFired: 'none',
  explanation: 'No configured rule distinguishes between these sources.',
  values: [
    {
      factId: 'fact-4',
      value: 7.2,
      unit: 'percent',
      sourceChunkId: 'chunk-d',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 6 },
    },
  ],
};

function renderPage() {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<ConflictsPage />} />
        {/* Static, not :id — pins the assertion to run.id ('run-1'), not run.workflowId
            ('wf-1'), so a regression to the wrong field fails the test instead of matching
            anything. */}
        <Route path="/workflow-runs/run-1" element={<p>run page probe</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

// Interleaves the conflicts fetch, the document-index fetches, and (in some tests) the
// resolution-request call — dispatch by URL rather than by call order.
function fetchStub(resolution?: () => Response, conflicts: unknown[] = [openConflict]) {
  return vi.fn((url: string, _init?: RequestInit) => {
    if (url === '/api/v1/conflicts') {
      return Promise.resolve(jsonResponse({ docs: conflicts, count: conflicts.length }));
    }
    if (url === '/api/v1/documents') {
      return Promise.resolve(jsonResponse({ docs: [documentFixture], count: 1 }));
    }
    if (url === '/api/v1/documents/doc-1') {
      return Promise.resolve(jsonResponse({ ...documentFixture, versions: [documentVersion] }));
    }
    if (url === '/api/v1/conflicts/conflict-1/resolution-requests' && resolution) {
      return Promise.resolve(resolution());
    }
    return Promise.reject(new Error(`Unhandled fetch: ${url}`));
  });
}

describe('ConflictsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists an open conflict with its fact key, status, and resolved values', async () => {
    vi.stubGlobal('fetch', fetchStub());

    renderPage();

    expect(screen.getByText('Loading…')).toBeInTheDocument();

    expect(await screen.findByText('Northgate Business Park')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.getByText('cap_rate')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('6.1 percent')).toBeInTheDocument();
    expect(await screen.findByText('Rent Roll Q1 — p.2')).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: /conflicting facts extracted from the evidence corpus/i }),
    ).toBeInTheDocument();
  });

  it('shows the recommended value with the rule that fired and why, next to that value', async () => {
    vi.stubGlobal('fetch', fetchStub());

    renderPage();

    expect(await screen.findByText('Recommended · authority')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Source 'chunk-a' outranks the other value's source under the authority policy.",
      ),
    ).toBeInTheDocument();
  });

  it('shows a recency-based recommendation the same way', async () => {
    vi.stubGlobal('fetch', fetchStub(undefined, [recencyConflict]));

    renderPage();

    expect(await screen.findByText('Recommended · recency')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Source 'chunk-c' was ingested more recently than the conflicting value's source.",
      ),
    ).toBeInTheDocument();
  });

  it('shows no recommendation when the policy declines to pick a winner', async () => {
    vi.stubGlobal('fetch', fetchStub(undefined, [undecidedConflict]));

    renderPage();

    expect(
      await screen.findByText(
        'Policy has no recommendation for this conflict — No configured rule distinguishes between these sources.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Recommended ·/)).not.toBeInTheDocument();
  });

  it('requests a resolution for a value and navigates to the run timeline', async () => {
    const fetchMock = fetchStub(() =>
      jsonResponse({
        id: 'run-1',
        workflowId: 'wf-1',
        status: 'running',
        createdAt: new Date().toISOString(),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    const resolveButton = await screen.findByRole('button', { name: 'Request resolution' });
    // The recommendation is a suggestion, never a decision — the resolution-request call only
    // happens once the human clicks, never as a side effect of the conflict (or its proposal)
    // simply loading and rendering.
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/conflicts/conflict-1/resolution-requests',
      ),
    ).toBe(false);

    fireEvent.click(resolveButton);

    expect(await screen.findByText('run page probe')).toBeInTheDocument();

    const resolutionCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/v1/conflicts/conflict-1/resolution-requests',
    );
    expect(resolutionCall).toBeDefined();
    expect(JSON.parse((resolutionCall![1] as RequestInit).body as string)).toEqual({
      winningFactId: 'fact-1',
    });
  });

  it('shows how many conflicts are visible against the total when the list is truncated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/v1/conflicts') {
          return Promise.resolve(jsonResponse({ docs: [openConflict], count: 47 }));
        }
        if (url === '/api/v1/documents') {
          return Promise.resolve(jsonResponse({ docs: [documentFixture], count: 1 }));
        }
        if (url === '/api/v1/documents/doc-1') {
          return Promise.resolve(jsonResponse({ ...documentFixture, versions: [documentVersion] }));
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      }),
    );

    renderPage();

    expect(await screen.findByText('Showing 1 of 47.')).toBeInTheDocument();
  });

  it('shows no truncation notice when the full conflict list fits on the page', async () => {
    vi.stubGlobal('fetch', fetchStub());

    renderPage();

    await screen.findByText('Northgate Business Park');
    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
  });

  it('shows a per-row error when the resolution request fails', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(() => jsonResponse({ message: 'Fact already resolved' }, 409)),
    );

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Request resolution' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Fact already resolved');
  });
});
