import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomePage from './HomePage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const me = {
  id: 'user-1',
  email: 'user@example.com',
  role: 'member',
  createdAt: '2026-01-15T09:30:00.000Z',
};

const sourceOk = {
  id: 'source-1',
  name: 'Deal Room Inbox',
  kind: 'local-folder',
  path: 'deal-room',
  enabled: true,
  fileCount: 3,
  createdAt: new Date().toISOString(),
};

const answered = {
  id: 'answer-1',
  questionText: 'What is the cap rate for Northgate?',
  runStatus: 'completed',
  outcome: { kind: 'answered', claims: [] },
  claimCoverage: 1,
  citations: [],
  conflictIds: [],
  createdAt: new Date().toISOString(),
};

const conflicting = {
  ...answered,
  id: 'answer-2',
  questionText: 'What is the occupancy rate?',
  outcome: {
    kind: 'conflicting_evidence',
    factKey: { entity: 'Northgate', metric: 'occupancy', period: '2025-03' },
    values: [],
  },
};

const insufficient = {
  ...answered,
  id: 'answer-3',
  questionText: 'What is the tenant improvement allowance?',
  outcome: { kind: 'insufficient_evidence', reason: 'No relevant evidence found.' },
};

const stillRunning = {
  ...answered,
  id: 'answer-4',
  questionText: 'What is the debt yield?',
  runStatus: 'running',
  outcome: undefined,
};

interface RouteOverrides {
  approvals?: () => Response;
  conflicts?: () => Response;
  documents?: () => Response;
  sources?: () => Response;
  answers?: () => Response;
  me?: () => Response;
}

// Every list route is keyed by its exact URL, query string included — a stub that only
// matched by path would silently accept a count from the wrong call.
function stubFetch(overrides: RouteOverrides = {}): ReturnType<typeof vi.fn> {
  const routes: Record<string, () => Response> = {
    '/api/v1/auth/me': overrides.me ?? (() => jsonResponse(me)),
    '/api/v1/approvals?state=pending':
      overrides.approvals ?? (() => jsonResponse({ docs: [], count: 12 })),
    '/api/v1/conflicts?limit=1&status=open':
      overrides.conflicts ?? (() => jsonResponse({ docs: [], count: 7 })),
    '/api/v1/documents': overrides.documents ?? (() => jsonResponse({ docs: [], count: 340 })),
    '/api/v1/sources': overrides.sources ?? (() => jsonResponse({ docs: [sourceOk], count: 1 })),
    '/api/v1/answers?limit=5':
      overrides.answers ?? (() => jsonResponse({ docs: [answered], count: 1 })),
  };
  const fetchMock = vi.fn((url: string) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

describe('HomePage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders tile counts from each response's count field, not the length of its docs page", async () => {
    // Every route below returns a single-item (or empty) docs page paired with a much larger
    // count — a length-based render would show 0 or 1 everywhere instead of these totals.
    stubFetch({
      approvals: () => jsonResponse({ docs: [], count: 12 }),
      conflicts: () => jsonResponse({ docs: [], count: 7 }),
      documents: () => jsonResponse({ docs: [answered], count: 340 }),
    });

    renderPage();

    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('340')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Pending approvals/ })).toHaveAttribute(
      'href',
      '/approvals',
    );
    expect(screen.getByRole('link', { name: /Open conflicts/ })).toHaveAttribute(
      'href',
      '/conflicts',
    );
    expect(screen.getByRole('link', { name: /Documents/ })).toHaveAttribute('href', '/documents');
    expect(screen.getByRole('link', { name: /Source health/ })).toHaveAttribute('href', '/sources');

    // Source health counts enabled sources from the returned docs — the endpoint has no
    // dedicated "enabled count" field — so this checks that path separately from the others.
    expect(screen.getByText('1')).toBeInTheDocument();

    expect(await screen.findByText('user@example.com')).toBeInTheDocument();
  });

  it('shows onboarding guidance instead of the dashboard for a brand-new tenant', async () => {
    stubFetch({
      documents: () => jsonResponse({ docs: [], count: 0 }),
      sources: () => jsonResponse({ docs: [], count: 0 }),
      answers: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Connect a source or upload a document, then ask a question to get started.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect a source' })).toHaveAttribute(
      'href',
      '/sources',
    );
    expect(screen.getByRole('link', { name: 'Upload a document' })).toHaveAttribute(
      'href',
      '/documents',
    );
    expect(screen.queryByRole('link', { name: /Pending approvals/ })).not.toBeInTheDocument();
  });

  it('keeps the other tiles rendering when a single tile fails to load', async () => {
    stubFetch({
      approvals: () => jsonResponse({ message: 'Approvals service unavailable' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Approvals service unavailable');
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(screen.getByText('340')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('shows all three answer outcomes as distinct badges, and a run status for one still in flight', async () => {
    stubFetch({
      answers: () =>
        jsonResponse({
          docs: [answered, conflicting, insufficient, stillRunning],
          count: 4,
        }),
    });

    renderPage();

    expect(await screen.findByText('What is the cap rate for Northgate?')).toBeInTheDocument();

    const answeredBadge = screen.getByText('answered');
    expect(answeredBadge.className).toContain('badge--strong');

    const conflictingBadge = screen.getByText('conflicting evidence');
    expect(conflictingBadge.className).toContain('badge--possible');

    const insufficientBadge = screen.getByText('insufficient evidence');
    expect(insufficientBadge.className).toContain('badge--info');

    const runningBadge = screen.getByText('running');
    expect(runningBadge.className).toContain('badge--info');

    expect(screen.getByRole('link', { name: 'What is the occupancy rate?' })).toHaveAttribute(
      'href',
      '/answers/answer-2',
    );
  });

  it('surfaces a failing sync as the source health headline instead of a bare count', async () => {
    const failingSource = {
      ...sourceOk,
      id: 'source-2',
      lastSyncError: 'Permission denied listing /deal-room',
    };
    stubFetch({
      sources: () => jsonResponse({ docs: [sourceOk, failingSource], count: 2 }),
    });

    renderPage();

    expect(await screen.findByText('1 sync error')).toBeInTheDocument();
    expect(screen.getByText('Permission denied listing /deal-room')).toBeInTheDocument();
  });
});
