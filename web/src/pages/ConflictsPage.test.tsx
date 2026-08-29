import { fireEvent, render, screen, within } from '@testing-library/react';
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
      withdrawn: false,
    },
  ],
  magnitude: 0.0085,
  magnitudeUnit: 'ratio',
  status: 'open',
  createdAt: new Date().toISOString(),
  stale: false,
  unscorable: false,
  proposedWinnerFactId: 'fact-1',
  ruleFired: 'authority',
  explanation: "Source 'chunk-a' outranks the other value's source under the authority policy.",
};

const recencyConflict = {
  ...openConflict,
  id: 'conflict-2',
  factKey: { entity: 'Riverside Plaza', metric: 'cap_rate', period: '2025-04' },
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
      withdrawn: false,
    },
  ],
};

const undecidedConflict = {
  ...openConflict,
  id: 'conflict-3',
  factKey: { entity: 'Sunset Corridor', metric: 'noi', period: '2025-05' },
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
      withdrawn: false,
    },
  ],
};

// A conflict whose evidence was deleted after it was resolved — `ConflictsService.list` degrades
// this to `unscorable: true` rather than throwing, so the row still renders with the one fact
// that still resolves, no ruleFired/proposedWinnerFactId/explanation, and a reason string.
const unscorableConflict = {
  ...openConflict,
  id: 'conflict-5',
  factKey: { entity: 'Harbor Point', metric: 'cap_rate', period: '2025-06' },
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
      withdrawn: false,
    },
  ],
};

// Carries `stale: true` — ConflictResponseDto's own contract promises a stale row stays "shown
// and labelled" rather than dropped.
const staleConflict = {
  ...openConflict,
  id: 'conflict-6',
  factKey: { entity: 'Meridian Yards', metric: 'cap_rate', period: '2025-07' },
  stale: true,
  staleReason: "Detected under pack 'cre' v1; the active pack is now 'cre' v2.",
};

// Three competing values on one conflict — the case a naive two-column layout breaks, with one
// value carrying `withdrawn: true`.
const threeWayConflict = {
  ...openConflict,
  id: 'conflict-7',
  factKey: { entity: 'Union Depot', metric: 'cap_rate', period: '2025-08' },
  factIds: ['fact-6', 'fact-7', 'fact-8'],
  proposedWinnerFactId: 'fact-6',
  values: [
    {
      factId: 'fact-6',
      value: 6.1,
      unit: 'percent',
      sourceChunkId: 'chunk-f',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 1 },
      withdrawn: false,
    },
    {
      factId: 'fact-7',
      value: 5.4,
      unit: 'percent',
      sourceChunkId: 'chunk-g',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      withdrawn: false,
    },
    {
      factId: 'fact-8',
      value: 7.9,
      unit: 'percent',
      sourceChunkId: 'chunk-h',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
      withdrawn: true,
    },
  ],
};

// The policy recommended a value whose source has since been withdrawn — no primary should render
// for it, since promoting dead evidence would manufacture a recommendation the system did not make.
const withdrawnWinnerConflict = {
  ...openConflict,
  id: 'conflict-8',
  factKey: { entity: 'Cedar Court', metric: 'cap_rate', period: '2025-09' },
  factIds: ['fact-9', 'fact-10'],
  proposedWinnerFactId: 'fact-9',
  values: [
    {
      factId: 'fact-9',
      value: 6.1,
      unit: 'percent',
      sourceChunkId: 'chunk-i',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 1 },
      withdrawn: true,
    },
    {
      factId: 'fact-10',
      value: 5.4,
      unit: 'percent',
      sourceChunkId: 'chunk-j',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      withdrawn: false,
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
    // Paginated (and, in some tests, filtered) — matched by prefix so the pager/filter/sort query
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

  it('keeps the queue pane before the detail pane, both reachable at once', async () => {
    vi.stubGlobal('fetch', fetchStub());

    renderPage();

    const queue = await screen.findByRole('region', { name: 'Conflicts queue' });
    const detail = screen.getByRole('region', { name: 'Conflict detail' });
    expect(queue).toBeInTheDocument();
    expect(detail).toBeInTheDocument();
    expect(queue.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists a conflict in the queue and shows it selected in the detail pane by default', async () => {
    vi.stubGlobal('fetch', fetchStub());

    renderPage();

    expect(screen.getByText('Loading conflicts…')).toBeInTheDocument();

    const queue = await screen.findByRole('region', { name: 'Conflicts queue' });
    expect(within(queue).getByText('Northgate Business Park')).toBeInTheDocument();
    expect(within(queue).getByText('cap_rate')).toBeInTheDocument();
    expect(within(queue).getByText('open')).toBeInTheDocument();

    const detail = screen.getByRole('region', { name: 'Conflict detail' });
    expect(
      within(detail).getByRole('heading', { name: 'Northgate Business Park' }),
    ).toBeInTheDocument();
    expect(within(detail).getByText('6.1 percent')).toBeInTheDocument();
    expect(await within(detail).findByText('Rent Roll Q1 — p.2')).toBeInTheDocument();
  });

  it('switches the detail pane when a different queue row is clicked', async () => {
    vi.stubGlobal('fetch', fetchStub(undefined, [openConflict, recencyConflict]));

    renderPage();

    const queue = await screen.findByRole('region', { name: 'Conflicts queue' });
    await within(queue).findByText('Northgate Business Park');

    fireEvent.click(within(queue).getByText('Riverside Plaza'));

    const detail = screen.getByRole('region', { name: 'Conflict detail' });
    expect(within(detail).getByRole('heading', { name: 'Riverside Plaza' })).toBeInTheDocument();
    expect(within(detail).getAllByText('Recommended · recency').length).toBeGreaterThan(0);
  });

  it('shows the recommended value with the rule that fired and why, above the grid and on its card', async () => {
    vi.stubGlobal('fetch', fetchStub());

    renderPage();

    // Once in the policy strip above the grid, once on the recommended card's own band.
    expect(await screen.findAllByText('Recommended · authority')).toHaveLength(2);
    expect(
      screen.getByText(
        "Source 'chunk-a' outranks the other value's source under the authority policy.",
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

  it('shows an unscorable conflict with its reason, untruncated, and never offers a resolve control for it', async () => {
    vi.stubGlobal('fetch', fetchStub(undefined, [unscorableConflict]));

    renderPage();

    const detail = await screen.findByRole('region', { name: 'Conflict detail' });
    expect(within(detail).getByText('Unscorable')).toBeInTheDocument();
    const reason = within(detail).getByText(
      '1 of 2 disagreeing fact(s) no longer resolve to an ExtractedFact.',
    );
    expect(reason).toBeInTheDocument();
    expect(reason).not.toHaveAttribute('title');
    expect(screen.getByText('5.25 percent')).toBeInTheDocument();
    expect(screen.queryByText(/^Recommended ·/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request resolution' })).not.toBeInTheDocument();
  });

  it('labels a stale conflict in both the queue row and the detail pane', async () => {
    vi.stubGlobal('fetch', fetchStub(undefined, [staleConflict]));

    renderPage();

    const queue = await screen.findByRole('region', { name: 'Conflicts queue' });
    expect(within(queue).getByText('Stale')).toBeInTheDocument();

    const detail = screen.getByRole('region', { name: 'Conflict detail' });
    expect(within(detail).getByText('Stale')).toBeInTheDocument();
    const reason = within(detail).getByText(
      "Detected under pack 'cre' v1; the active pack is now 'cre' v2.",
    );
    expect(reason).toBeInTheDocument();
    expect(reason).not.toHaveAttribute('title');
  });

  it('reads correctly with three or more competing values, labelling the withdrawn one', async () => {
    vi.stubGlobal('fetch', fetchStub(undefined, [threeWayConflict]));

    renderPage();

    const detail = await screen.findByRole('region', { name: 'Conflict detail' });
    expect(within(detail).getByText('6.1 percent')).toBeInTheDocument();
    expect(within(detail).getByText('5.4 percent')).toBeInTheDocument();
    expect(within(detail).getByText('7.9 percent')).toBeInTheDocument();
    expect(within(detail).getByText('Source withdrawn')).toBeInTheDocument();
  });

  it('offers a primary resolve action on the recommended card only, secondary on every other', async () => {
    vi.stubGlobal('fetch', fetchStub(undefined, [threeWayConflict]));

    renderPage();

    const detail = await screen.findByRole('region', { name: 'Conflict detail' });
    const resolveButtons = within(detail).getAllByRole('button', { name: 'Request resolution' });
    expect(resolveButtons).toHaveLength(3);
    // fact-6 (6.1 percent) is threeWayConflict's proposedWinnerFactId and is not withdrawn — its
    // action is the pane's only primary. fact-7 (5.4 percent) is neither recommended nor withdrawn,
    // and fact-8 (7.9 percent) is withdrawn — neither gets primary treatment.
    expect(resolveButtons[0]).toHaveClass('btn--primary');
    expect(resolveButtons[1]).toHaveClass('btn--secondary');
    expect(resolveButtons[2]).toHaveClass('btn--secondary');
  });

  it('offers no primary resolve action when the policy has no recommendation', async () => {
    vi.stubGlobal('fetch', fetchStub(undefined, [undecidedConflict]));

    renderPage();

    const resolveButton = await screen.findByRole('button', { name: 'Request resolution' });
    expect(resolveButton).toHaveClass('btn--secondary');
    expect(resolveButton).not.toHaveClass('btn--primary');
  });

  it('offers no primary resolve action when the recommended value has been withdrawn', async () => {
    vi.stubGlobal('fetch', fetchStub(undefined, [withdrawnWinnerConflict]));

    renderPage();

    const detail = await screen.findByRole('region', { name: 'Conflict detail' });
    const resolveButtons = within(detail).getAllByRole('button', { name: 'Request resolution' });
    expect(resolveButtons).toHaveLength(2);
    expect(resolveButtons.some((button) => button.classList.contains('btn--primary'))).toBe(false);
  });

  it('opens a confirm dialog before requesting a resolution, and does not fire on load', async () => {
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
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/conflicts/conflict-1/resolution-requests',
      ),
    ).toBe(false);

    fireEvent.click(resolveButton);

    const dialog = await screen.findByRole('dialog', { name: 'Request resolution' });
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/conflicts/conflict-1/resolution-requests',
      ),
    ).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Request resolution' }));

    expect(await screen.findByText('run page probe')).toBeInTheDocument();

    const resolutionCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/v1/conflicts/conflict-1/resolution-requests',
    );
    expect(resolutionCall).toBeDefined();
    expect(JSON.parse((resolutionCall![1] as RequestInit).body as string)).toEqual({
      winningFactId: 'fact-1',
    });
  });

  it('cannot double-fire the resolution request while the dialog is busy', async () => {
    let resolveResponse: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/conflicts/conflict-1/resolution-requests') return pending;
      if (url === '/api/v1/conflicts' || url.startsWith('/api/v1/conflicts?')) {
        return Promise.resolve(jsonResponse({ docs: [openConflict], count: 1 }));
      }
      if (url.startsWith('/api/v1/documents/versions/lookup')) {
        return Promise.resolve(jsonResponse({ docs: [versionLookup], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Request resolution' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request resolution' });
    const confirmButton = within(dialog).getByRole('button', { name: 'Request resolution' });

    fireEvent.click(confirmButton);
    const busyButton = await within(dialog).findByRole('button', { name: 'Request resolution…' });
    expect(busyButton).toBeDisabled();
    fireEvent.click(busyButton);

    resolveResponse(
      jsonResponse({
        id: 'run-1',
        workflowId: 'wf-1',
        status: 'running',
        createdAt: new Date().toISOString(),
      }),
    );
    await screen.findByText('run page probe');

    const resolutionCalls = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/v1/conflicts/conflict-1/resolution-requests',
    );
    expect(resolutionCalls).toHaveLength(1);
  });

  it('keeps the dialog open with the request error when the resolution request fails', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(() => jsonResponse({ message: 'Fact already resolved' }, 409)),
    );

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Request resolution' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request resolution' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request resolution' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Fact already resolved');
    expect(screen.getByRole('dialog', { name: 'Request resolution' })).toBeInTheDocument();
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

    expect(await screen.findByText('1–20 of 47')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('applies the status filter on submit and resets paging to the first page', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/conflicts?skip=0&limit=20&status=resolved&sort=createdAt&sortDir=desc') {
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

    const detail = await screen.findByRole('region', { name: 'Conflict detail' });
    await within(detail).findByRole('heading', { name: 'Northgate Business Park' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('21–40 of 47');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'resolved' } });
    expect(fetchMock.mock.calls.some(([url]) => url.includes('status=resolved'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(
      await within(detail).findByRole('heading', { name: 'Riverside Plaza' }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          url === '/api/v1/conflicts?skip=0&limit=20&status=resolved&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
  });

  it('sorts by status without offering magnitude as a sort field', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/conflicts?skip=0&limit=20&sort=status&sortDir=asc') {
        return Promise.resolve(jsonResponse({ docs: [recencyConflict], count: 1 }));
      }
      if (url === '/api/v1/conflicts' || url.startsWith('/api/v1/conflicts?')) {
        return Promise.resolve(jsonResponse({ docs: [openConflict], count: 1 }));
      }
      if (url.startsWith('/api/v1/documents/versions/lookup')) {
        return Promise.resolve(jsonResponse({ docs: [versionLookup], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    const detail = await screen.findByRole('region', { name: 'Conflict detail' });
    await within(detail).findByRole('heading', { name: 'Northgate Business Park' });

    const sortSelect = screen.getByLabelText('Sort');
    const sortableValues = [...sortSelect.querySelectorAll('option')].map((option) => option.value);
    expect(sortableValues.every((value) => !value.startsWith('magnitude'))).toBe(true);

    fireEvent.change(sortSelect, { target: { value: 'status-asc' } });

    expect(
      await within(detail).findByRole('heading', { name: 'Riverside Plaza' }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/conflicts?skip=0&limit=20&sort=status&sortDir=asc',
      ),
    ).toBe(true);
  });
});
