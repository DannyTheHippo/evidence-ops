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

// The batch lookup row for `docver-1` — every fixture conflict cites this same version, matching
// `documents/versions/lookup`'s response shape rather than the single-document detail shape.
const versionLookup = {
  versionId: 'docver-1',
  documentId: 'doc-1',
  documentTitle: 'Rent Roll Q1',
  versionNumber: 1,
  sourceKind: 'pdf',
  withdrawn: false,
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
  unscorable: false,
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

// A conflict whose evidence was deleted after it was resolved — `ConflictsService.list` degrades
// this to `unscorable: true` rather than throwing, so the row still renders with the one fact
// that still resolves, no ruleFired/proposedWinnerFactId/explanation, and a reason string.
const unscorableConflict = {
  ...openConflict,
  id: 'conflict-5',
  status: 'resolved',
  unscorable: true,
  unscorableReason: '1 of 2 disagreeing fact(s) no longer resolve to an ExtractedFact.',
  proposedWinnerFactId: undefined,
  ruleFired: undefined,
  explanation: undefined,
  values: [
    {
      factId: 'fact-5',
      value: 5.25,
      unit: 'percent',
      sourceChunkId: 'chunk-e',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 8 },
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

// Interleaves the conflicts fetch, the document-index lookup, and (in some tests) the
// resolution-request call — dispatch by URL rather than by call order.
function fetchStub(resolution?: () => Response, conflicts: unknown[] = [openConflict]) {
  return vi.fn((url: string, _init?: RequestInit) => {
    if (url === '/api/v1/conflicts/conflict-1/resolution-requests' && resolution) {
      return Promise.resolve(resolution());
    }
    // Paginated (and, in some tests, filtered) — matched by prefix so the pager/filter query
    // string does not have to be spelled out at every call site.
    if (url === '/api/v1/conflicts' || url.startsWith('/api/v1/conflicts?')) {
      return Promise.resolve(jsonResponse({ docs: conflicts, count: conflicts.length }));
    }
    if (url.startsWith('/api/v1/documents/versions/lookup')) {
      return Promise.resolve(jsonResponse({ docs: [versionLookup], count: 1 }));
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

    expect(screen.getByText('Loading conflicts…')).toBeInTheDocument();

    expect(await screen.findByText('Northgate Business Park')).toBeInTheDocument();
    expect(screen.queryByText('Loading conflicts…')).not.toBeInTheDocument();
    expect(screen.getByText('cap_rate')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('6.1 percent')).toBeInTheDocument();
    expect(await screen.findByText('Rent Roll Q1 — p.2')).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: /conflicting facts extracted from the evidence corpus/i }),
    ).toBeInTheDocument();
  });

  it('shows the recommended value with the rule that fired and why, next to that value', async () => {
    vi.stubGlobal('fetch', fetchStub());

    renderPage();

    expect(await screen.findByText('recommended · authority')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Source 'chunk-a' outranks the other value's source under the authority policy.",
      ),
    ).toBeInTheDocument();
  });

  it('shows a recency-based recommendation the same way', async () => {
    vi.stubGlobal('fetch', fetchStub(undefined, [recencyConflict]));

    renderPage();

    expect(await screen.findByText('recommended · recency')).toBeInTheDocument();
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
    expect(screen.queryByText(/^recommended ·/)).not.toBeInTheDocument();
  });

  it('shows an unscorable conflict with its reason and remaining evidence, instead of dropping the row', async () => {
    vi.stubGlobal('fetch', fetchStub(undefined, [unscorableConflict]));

    renderPage();

    expect(await screen.findByText('Northgate Business Park')).toBeInTheDocument();
    expect(screen.getByText('Unscorable')).toBeInTheDocument();
    expect(
      screen.getByText('1 of 2 disagreeing fact(s) no longer resolve to an ExtractedFact.'),
    ).toBeInTheDocument();
    expect(screen.getByText('5.25 percent')).toBeInTheDocument();
    expect(screen.queryByText(/^recommended ·/)).not.toBeInTheDocument();
    // A resolved conflict never shows the resolve control regardless of unscorable — same gate
    // as `status === 'open'` for every other conflict.
    expect(screen.queryByRole('button', { name: 'Request resolution' })).not.toBeInTheDocument();
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

  it('shows the pager total and keeps Next enabled when the list is truncated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/v1/conflicts' || url.startsWith('/api/v1/conflicts?')) {
          return Promise.resolve(jsonResponse({ docs: [openConflict], count: 47 }));
        }
        if (url.startsWith('/api/v1/documents/versions/lookup')) {
          return Promise.resolve(jsonResponse({ docs: [versionLookup], count: 1 }));
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      }),
    );

    renderPage();

    expect(await screen.findByText('47 total')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('disables Next once the full conflict list fits on the page', async () => {
    vi.stubGlobal('fetch', fetchStub());

    renderPage();

    await screen.findByText('Northgate Business Park');
    expect(screen.getByText('1 total')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('pages past the first 20 conflicts, sending skip/limit on the request', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/conflicts?skip=20&limit=20') {
        return Promise.resolve(jsonResponse({ docs: [recencyConflict], count: 47 }));
      }
      if (url === '/api/v1/conflicts' || url.startsWith('/api/v1/conflicts?')) {
        return Promise.resolve(jsonResponse({ docs: [openConflict], count: 47 }));
      }
      if (url.startsWith('/api/v1/documents/versions/lookup')) {
        return Promise.resolve(jsonResponse({ docs: [versionLookup], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await screen.findByText('Northgate Business Park');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('recommended · recency')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/conflicts?skip=20&limit=20')).toBe(
      true,
    );
  });

  it('applies the status filter on submit and resets paging to the first page', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/conflicts?skip=0&limit=20&status=resolved') {
        return Promise.resolve(jsonResponse({ docs: [recencyConflict], count: 1 }));
      }
      if (url === '/api/v1/conflicts' || url.startsWith('/api/v1/conflicts?')) {
        return Promise.resolve(jsonResponse({ docs: [openConflict], count: 47 }));
      }
      if (url.startsWith('/api/v1/documents/versions/lookup')) {
        return Promise.resolve(jsonResponse({ docs: [versionLookup], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await screen.findByText('Northgate Business Park');
    // Advance to page 2 first, so the filter submit below is what proves skip resets to 0.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('47 total');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'resolved' } });
    // Selecting the filter alone must not refire the fetch — only Apply does.
    expect(fetchMock.mock.calls.some(([url]) => url.includes('status=resolved'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText('recommended · recency')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/conflicts?skip=0&limit=20&status=resolved',
      ),
    ).toBe(true);
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
