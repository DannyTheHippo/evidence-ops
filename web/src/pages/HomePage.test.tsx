import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomePage from './HomePage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const documentOk = {
  id: 'doc-1',
  title: 'Lease Agreement.pdf',
  sourceKind: 'pdf',
  mimeType: 'application/pdf',
  currentVersion: {
    id: 'version-1',
    versionNumber: 1,
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    ingestionStatus: 'completed',
    createdAt: new Date().toISOString(),
  },
  createdAt: new Date().toISOString(),
};

const documentFailed = {
  ...documentOk,
  id: 'doc-2',
  title: 'Q3 Financials.xlsx',
  currentVersion: {
    ...documentOk.currentVersion,
    id: 'version-2',
    ingestionStatus: 'failed',
    ingestionFailureReason: 'XLSX parse failed: corrupt workbook',
  },
};

const sourceOk = {
  id: 'source-1',
  name: 'Deal Room Inbox',
  kind: 'local-folder',
  path: 'deal-room',
  enabled: true,
  fileCount: 3,
  connectivity: 'connector',
  reachability: 'live',
  owner: 'Jane Doe, IT',
  tracked: true,
  sourceClass: 'unclassified',
  createdAt: new Date().toISOString(),
};

const failingSource = {
  ...sourceOk,
  id: 'source-2',
  name: 'Second Source',
  lastSyncStatus: 'failed',
  lastSyncError: 'Permission denied listing /deal-room',
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

const approvalPending = {
  id: 'approval-1',
  subject: { entityType: 'Conflict', entityId: 'conflict-9' },
  action: 'resolve-conflict',
  summary: 'Approve resolving the occupancy rate conflict',
  state: 'pending',
  createdAt: new Date().toISOString(),
};

const conflictOpen = {
  id: 'conflict-1',
  factKey: { entity: 'Northgate', metric: 'occupancy', period: '2025-03' },
  factIds: ['fact-1', 'fact-2'],
  values: [],
  magnitude: 0.1,
  status: 'open',
  createdAt: new Date().toISOString(),
  ruleFired: 'none',
  explanation: 'No policy rule fired for this fact.',
};

interface RouteOverrides {
  approvals?: () => Response;
  conflicts?: () => Response;
  documents?: () => Response;
  sources?: () => Response;
  failedDocuments?: () => Response;
  failedSources?: () => Response;
  answers?: () => Response;
}

// Every list route is keyed by its exact URL, query string included — a stub that only
// matched by path would silently accept a response from the wrong call. `documents`/`sources`
// feed only the first-run checklist and empty-tenant check; `failedDocuments`/`failedSources`
// feed corpus health, through the server's own failed-only filters rather than a client-side
// scan of the unfiltered page.
function stubFetch(overrides: RouteOverrides = {}): ReturnType<typeof vi.fn> {
  const routes: Record<string, () => Response> = {
    '/api/v1/approvals?limit=5&state=pending':
      overrides.approvals ?? (() => jsonResponse({ docs: [], count: 0 })),
    '/api/v1/conflicts?limit=5&status=open':
      overrides.conflicts ?? (() => jsonResponse({ docs: [], count: 0 })),
    '/api/v1/documents?limit=100':
      overrides.documents ?? (() => jsonResponse({ docs: [documentOk], count: 1 })),
    '/api/v1/sources?limit=100':
      overrides.sources ?? (() => jsonResponse({ docs: [sourceOk], count: 1 })),
    '/api/v1/documents?limit=100&ingestionStatus=failed':
      overrides.failedDocuments ?? (() => jsonResponse({ docs: [], count: 0 })),
    '/api/v1/sources?limit=100&lastSyncStatus=failed':
      overrides.failedSources ?? (() => jsonResponse({ docs: [], count: 0 })),
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

  it('names a specific pending approval and open conflict in the work queue, each linking to where it is decided', async () => {
    stubFetch({
      approvals: () => jsonResponse({ docs: [approvalPending], count: 4 }),
      conflicts: () => jsonResponse({ docs: [conflictOpen], count: 2 }),
    });

    renderPage();

    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(
      await screen.findByText('Approve resolving the occupancy rate conflict'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Approve resolving the occupancy rate conflict' }),
    ).toHaveAttribute('href', '/approvals');

    expect(screen.getByText('Northgate — occupancy (2025-03)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Northgate — occupancy (2025-03)' })).toHaveAttribute(
      'href',
      '/conflicts',
    );

    expect(screen.getByText('4 pending approvals · 2 open conflicts')).toBeInTheDocument();
  });

  it('surfaces a failed ingestion and a failed sync in corpus health, naming the item and its reason', async () => {
    stubFetch({
      failedDocuments: () => jsonResponse({ docs: [documentFailed], count: 1 }),
      failedSources: () => jsonResponse({ docs: [failingSource], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Q3 Financials.xlsx')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Q3 Financials.xlsx' })).toHaveAttribute(
      'href',
      '/documents/doc-2',
    );
    expect(screen.getByText(/XLSX parse failed: corrupt workbook/)).toBeInTheDocument();
    expect(screen.getByText('Ingestion failed')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Second Source' })).toHaveAttribute(
      'href',
      '/sources/source-2',
    );
    expect(screen.getByText(/Permission denied listing \/deal-room/)).toBeInTheDocument();
    expect(screen.getByText('Sync failed')).toBeInTheDocument();

    // documentOk and sourceOk both ingested/synced cleanly and must not appear as failures.
    expect(screen.queryByText('Lease Agreement.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText('Deal Room Inbox')).not.toBeInTheDocument();
  });

  it('surfaces a failure older than the newest-100 window, invisible to the unfiltered fetch that only feeds the checklist', async () => {
    const oldFailedDocument = {
      ...documentFailed,
      id: 'doc-old',
      title: 'Archived Rent Roll 2019.xlsx',
    };
    stubFetch({
      // The unfiltered document fetch (which only ever drives the first-run checklist) reports a
      // corpus with no failure in view — simulating one older than the newest-100 window — while
      // the failed-only filter still finds it.
      documents: () => jsonResponse({ docs: [documentOk], count: 500 }),
      failedDocuments: () => jsonResponse({ docs: [oldFailedDocument], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Archived Rent Roll 2019.xlsx')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Archived Rent Roll 2019.xlsx' })).toHaveAttribute(
      'href',
      '/documents/doc-old',
    );
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

  it('shows the first-run checklist alone, superseding the other three sections, for a brand-new tenant', async () => {
    stubFetch({
      documents: () => jsonResponse({ docs: [], count: 0 }),
      sources: () => jsonResponse({ docs: [], count: 0 }),
      answers: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Get started' })).toBeInTheDocument();
    expect(screen.getByText('Add a source or upload a document')).toBeInTheDocument();
    expect(screen.getByText('Wait for ingestion to complete')).toBeInTheDocument();
    // "Ask a question" is both the step label and the still-undone step's call-to-action link, so
    // this scopes the match to the label span rather than colliding with the link text.
    expect(
      screen.getByText('Ask a question', { selector: '.actionable-row-name' }),
    ).toBeInTheDocument();

    expect(screen.queryByRole('heading', { name: 'Work queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Corpus health' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recent answers' })).not.toBeInTheDocument();
  });

  it('marks a checklist step done once its signal is satisfied, without hiding the other sections', async () => {
    stubFetch({
      documents: () => jsonResponse({ docs: [], count: 0 }),
      sources: () => jsonResponse({ docs: [sourceOk], count: 1 }),
      answers: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Get started' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Work queue' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Corpus health' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent answers' })).toBeInTheDocument();

    const connectStep = screen.getByText('Add a source or upload a document').closest('li');
    expect(connectStep).not.toBeNull();
    expect(within(connectStep as HTMLElement).getByText('done')).toBeInTheDocument();

    const ingestStep = screen.getByText('Wait for ingestion to complete').closest('li');
    expect(ingestStep).not.toBeNull();
    expect(
      within(ingestStep as HTMLElement).getByRole('link', { name: 'View documents' }),
    ).toBeInTheDocument();
  });

  it('keeps the other sections rendering when a single fetch fails', async () => {
    stubFetch({
      approvals: () => jsonResponse({ message: 'Approvals service unavailable' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Approvals service unavailable');
    expect(screen.getByRole('heading', { name: 'Work queue' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Corpus health' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent answers' })).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
