import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession, ensureSession } from '../lib/auth';
import HomePage from './HomePage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const summaryHealthy = {
  pendingApprovalCount: 0,
  openConflictCount: 0,
  documentCount: 1,
  sourceCount: 1,
  ingestionFailedCount: 0,
  syncFailedCount: 0,
  needsOcrCount: 0,
  factsFailedCount: 0,
  answerCount: 1,
  hasIngestedDocument: true,
};

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

const documentFactsFailed = {
  ...documentOk,
  id: 'doc-4',
  title: 'Northgate Rent Roll.xlsx',
  currentVersion: {
    ...documentOk.currentVersion,
    id: 'version-4',
    ingestionStatus: 'facts-failed',
    ingestionFailureReason: 'Fact extraction failed: model returned no parseable output',
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
  workflowId: 'wf-1',
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

// Carries a recommended winner, unlike conflictOpen above — this is the shape the work queue's
// inline "Request resolution" control needs; conflictOpen's ruleFired: 'none' has no winner to
// request, which is why that row surfaces no inline control of its own.
const conflictWithRecommendation = {
  ...conflictOpen,
  id: 'conflict-2',
  values: [
    {
      factId: 'fact-3',
      value: 92,
      unit: 'percent',
      sourceChunkId: 'chunk-a',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      withdrawn: false,
    },
  ],
  proposedWinnerFactId: 'fact-3',
  ruleFired: 'authority',
  explanation: "Source 'chunk-a' outranks the other value's source under the authority policy.",
};

const admin = {
  id: 'user-1',
  email: 'admin@example.com',
  role: 'admin' as const,
  createdAt: new Date().toISOString(),
};

const member = {
  id: 'user-2',
  email: 'member@example.com',
  role: 'member' as const,
  createdAt: new Date().toISOString(),
};

interface RouteOverrides {
  me?: () => Response;
  summary?: () => Response;
  approvals?: () => Response;
  conflicts?: () => Response;
  failedDocuments?: () => Response;
  failedSources?: () => Response;
  factsFailedDocuments?: () => Response;
  answers?: () => Response;
  extraRoutes?: Record<string, () => Response>;
}

// Every list route is keyed by its exact URL, query string included — a stub that only matched
// by path would silently accept a response from the wrong call. `summary` feeds the stat row and
// the first-run checklist's funnel signals; `failedDocuments`/`failedSources`/
// `factsFailedDocuments` feed corpus health, through the server's own status-filtered queries
// rather than a client-side scan of an unfiltered page. `me` defaults to `admin` — most tests
// below exercise content rendering, not the approve/reject role gate, so admin is the shape that
// keeps every inline control visible unless a test overrides it. `extraRoutes` covers the one-off
// action endpoints (decide, resolution-request, sync, upload) an individual test needs, so
// `RouteOverrides` above stays free of a field per action.
function stubFetch(overrides: RouteOverrides = {}): ReturnType<typeof vi.fn> {
  const routes: Record<string, () => Response> = {
    '/api/v1/auth/me': overrides.me ?? (() => jsonResponse(admin)),
    '/api/v1/dashboard/summary': overrides.summary ?? (() => jsonResponse(summaryHealthy)),
    '/api/v1/approvals?limit=5&state=pending':
      overrides.approvals ?? (() => jsonResponse({ docs: [], count: 0 })),
    '/api/v1/conflicts?limit=5&status=open':
      overrides.conflicts ?? (() => jsonResponse({ docs: [], count: 0 })),
    '/api/v1/documents?limit=100&ingestionStatus=failed':
      overrides.failedDocuments ?? (() => jsonResponse({ docs: [], count: 0 })),
    '/api/v1/sources?limit=100&lastSyncStatus=failed':
      overrides.failedSources ?? (() => jsonResponse({ docs: [], count: 0 })),
    '/api/v1/documents?limit=100&ingestionStatus=facts-failed':
      overrides.factsFailedDocuments ?? (() => jsonResponse({ docs: [], count: 0 })),
    '/api/v1/answers?limit=5':
      overrides.answers ?? (() => jsonResponse({ docs: [answered], count: 1 })),
    ...overrides.extraRoutes,
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
    // useSession() shares auth.ts's module-level session cache; without this, whichever role
    // the first test in this file probes for would leak into every later test.
    clearSession();
  });

  it('drives the stat row from the dashboard summary, tinting each figure only once it is actually nonzero', async () => {
    stubFetch({
      summary: () =>
        jsonResponse({
          ...summaryHealthy,
          pendingApprovalCount: 4,
          openConflictCount: 2,
          ingestionFailedCount: 1,
          syncFailedCount: 1,
          factsFailedCount: 1,
          needsOcrCount: 5,
        }),
    });

    renderPage();

    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(await screen.findByText('4')).toBeInTheDocument();
    expect(screen.getByText('4').className).toContain('stat-row-value--caution');
    expect(screen.getByRole('link', { name: /Pending approvals/ })).toHaveAttribute(
      'href',
      '/adjudication?kind=decisions&state=pending',
    );

    expect(screen.getByText('2').className).toContain('stat-row-value--caution');
    expect(screen.getByRole('link', { name: /Open conflicts/ })).toHaveAttribute(
      'href',
      '/adjudication?kind=conflicts&status=open',
    );

    expect(screen.getByText('3').className).toContain('stat-row-value--rejected');
    expect(screen.getByText('1 ingestion · 1 sync · 1 facts')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Corpus failures/ })).toHaveAttribute(
      'href',
      '/documents?ingestionStatus=failed',
    );

    const needsOcrValue = screen.getByText('5');
    expect(needsOcrValue.className).not.toContain('stat-row-value--caution');
    expect(needsOcrValue.className).not.toContain('stat-row-value--rejected');
  });

  it('renders a dash and an "unavailable" hint instead of a zero when the summary fetch fails', async () => {
    stubFetch({
      summary: () => jsonResponse({ message: 'Summary service unavailable' }, 500),
    });

    renderPage();

    expect(await screen.findAllByText('—')).toHaveLength(4);
    expect(screen.getAllByText('unavailable')).toHaveLength(4);
    // A count that could not be fetched is not "zero" — none of the four stats may tint as if a
    // real zero (or a real failure) had been confirmed.
    for (const value of screen.getAllByText('—')) {
      expect(value.className).not.toContain('stat-row-value--caution');
      expect(value.className).not.toContain('stat-row-value--rejected');
    }
  });

  it('suppresses the empty-tenant checklist and the get-started section when the summary fetch fails, even for an otherwise-empty response', async () => {
    stubFetch({
      summary: () => jsonResponse({ message: 'Summary service unavailable' }, 500),
      answers: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Work queue' })).toBeInTheDocument();
    // The onboarding funnel needs the summary to know the tenant is actually empty — a failed
    // fetch must not let a coerced-to-zero count masquerade as a confirmed empty or complete
    // tenant in either direction.
    expect(screen.queryByRole('heading', { name: 'Get started' })).not.toBeInTheDocument();
  });

  it('names a specific pending approval and open conflict in the work queue, badged by kind and linking to where it is decided', async () => {
    stubFetch({
      approvals: () => jsonResponse({ docs: [approvalPending], count: 1 }),
      conflicts: () => jsonResponse({ docs: [conflictOpen], count: 1 }),
    });

    renderPage();

    expect(
      await screen.findByText('Approve resolving the occupancy rate conflict'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Approve resolving the occupancy rate conflict' }),
    ).toHaveAttribute('href', '/adjudication?kind=decisions&state=pending&selected=approval-1');
    // An approval is a process state awaiting a decision, badged `info`; a conflict is data
    // actually in contention, badged `caution` — the two kinds of row must not look identical.
    expect(screen.getByText('Approval').className).toContain('badge--info');

    expect(screen.getByText('Northgate — occupancy (2025-03)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Northgate — occupancy (2025-03)' })).toHaveAttribute(
      'href',
      '/adjudication?kind=conflicts&selected=conflict-1',
    );
    expect(screen.getByText('Conflict').className).toContain('badge--possible');
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
    expect(screen.getByText('XLSX parse failed: corrupt workbook')).toBeInTheDocument();
    expect(screen.getByText('Ingestion failed')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Second Source' })).toHaveAttribute(
      'href',
      '/sources/source-2',
    );
    expect(screen.getByText('Permission denied listing /deal-room')).toBeInTheDocument();
    expect(screen.getByText('Sync failed')).toBeInTheDocument();

    // documentOk and sourceOk both ingested/synced cleanly and must not appear as failures.
    expect(screen.queryByText('Lease Agreement.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText('Deal Room Inbox')).not.toBeInTheDocument();
  });

  it('surfaces a facts-failed document as its own corpus-health row, cautioned rather than rejected', async () => {
    stubFetch({
      factsFailedDocuments: () => jsonResponse({ docs: [documentFactsFailed], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Northgate Rent Roll.xlsx')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Northgate Rent Roll.xlsx' })).toHaveAttribute(
      'href',
      '/documents/doc-4',
    );
    expect(
      screen.getByText('Fact extraction failed: model returned no parseable output'),
    ).toBeInTheDocument();

    // The document is searchable and its chunks are citable, so the row carries the caution tone,
    // not the 'rejected' tone an ingestion failure carries.
    expect(screen.getByText('No facts extracted').className).toContain('badge--possible');
  });

  it('orders corpus health by severity — ingestion failures, then sync failures, then facts-failed documents', async () => {
    stubFetch({
      failedDocuments: () => jsonResponse({ docs: [documentFailed], count: 1 }),
      failedSources: () => jsonResponse({ docs: [failingSource], count: 1 }),
      factsFailedDocuments: () => jsonResponse({ docs: [documentFactsFailed], count: 1 }),
    });

    renderPage();

    const list = await screen.findByText('Q3 Financials.xlsx').then((el) => el.closest('ul'));
    expect(list).not.toBeNull();
    const rowNames = within(list as HTMLElement)
      .getAllByRole('link', { name: /Financials|Second Source|Rent Roll/ })
      .map((el) => el.textContent);
    expect(rowNames).toEqual(['Q3 Financials.xlsx', 'Second Source', 'Northgate Rent Roll.xlsx']);
  });

  it('leaves the corpus-health queue empty when nothing failed, extracted no facts, or fell out of sync', async () => {
    stubFetch();

    renderPage();

    expect(
      await screen.findByText('No ingestion, extraction or sync failures'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No facts extracted')).not.toBeInTheDocument();
  });

  it('surfaces a failure older than the newest-100 window, invisible to a fixed-size unfiltered scan', async () => {
    const oldFailedDocument = {
      ...documentFailed,
      id: 'doc-old',
      title: 'Archived Rent Roll 2019.xlsx',
    };
    stubFetch({
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
      summary: () =>
        jsonResponse({ ...summaryHealthy, documentCount: 0, sourceCount: 0, answerCount: 0 }),
      answers: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Get started' })).toBeInTheDocument();
    expect(screen.getByText('Add a source or upload a document')).toBeInTheDocument();
    expect(screen.getByText('Wait for ingestion to complete')).toBeInTheDocument();
    // "Ask a question" is both the step label and the still-undone step's call-to-action link, so
    // this scopes the match to the label span rather than colliding with the link text.
    expect(screen.getByText('Ask a question', { selector: '.stepper-label' })).toBeInTheDocument();

    expect(screen.queryByRole('heading', { name: 'Work queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Corpus health' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recent answers' })).not.toBeInTheDocument();
  });

  it('marks a checklist step done once its signal is satisfied, without hiding the other sections, and puts the one primary CTA on the first undone step', async () => {
    stubFetch({
      summary: () =>
        jsonResponse({
          ...summaryHealthy,
          documentCount: 0,
          sourceCount: 1,
          answerCount: 0,
          hasIngestedDocument: false,
        }),
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
    expect(connectStep as HTMLElement).toHaveClass('is-done');

    const ingestStep = screen.getByText('Wait for ingestion to complete').closest('li');
    expect(ingestStep).not.toBeNull();
    const ingestLink = within(ingestStep as HTMLElement).getByRole('link', {
      name: 'View documents',
    });
    expect(ingestLink).toBeInTheDocument();
    expect(ingestLink.className).toContain('btn--primary');

    const askStep = screen
      .getByText('Ask a question', { selector: '.stepper-label' })
      .closest('li');
    const askLink = within(askStep as HTMLElement).getByRole('link', { name: 'Ask a question' });
    expect(askLink.className).toContain('btn--secondary');
  });

  it('consolidates a single work-queue failure into one alert naming it and carrying its message, with a way to retry', async () => {
    const fetchMock = stubFetch({
      approvals: () => jsonResponse({ message: 'Approvals service unavailable' }, 500),
    });

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load: approvals");
    expect(alert).toHaveTextContent('Approvals service unavailable');
    expect(screen.getByRole('heading', { name: 'Work queue' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Corpus health' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent answers' })).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    const callsBefore = fetchMock.mock.calls.length;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('consolidates every work-queue failure into one alert naming both, without an empty-state claim', async () => {
    stubFetch({
      approvals: () => jsonResponse({ message: 'Approvals service unavailable' }, 500),
      conflicts: () => jsonResponse({ message: 'Conflicts service unavailable' }, 500),
    });

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load: approvals, conflicts");
    expect(alert).toHaveTextContent('Approvals service unavailable');
    expect(alert).toHaveTextContent('Conflicts service unavailable');
    // Neither fetch resolved any data, so there is nothing to call empty — a false "nothing needs
    // your attention" claim would misreport a data-loading failure as a healthy, empty queue.
    expect(screen.queryByText('Nothing needs your attention')).not.toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('consolidates every corpus-health failure into one alert naming the affected domains', async () => {
    stubFetch({
      failedDocuments: () => jsonResponse({ message: 'Documents service unavailable' }, 500),
      failedSources: () => jsonResponse({ message: 'Sources service unavailable' }, 500),
      factsFailedDocuments: () => jsonResponse({ message: 'Documents service unavailable' }, 500),
    });

    renderPage();

    await screen.findByRole('heading', { name: 'Corpus health' });
    const corpusCard = screen.getByRole('heading', { name: 'Corpus health' }).closest('section');
    expect(corpusCard).not.toBeNull();
    const alert = within(corpusCard as HTMLElement).getByRole('alert');
    // Two of the three failing legs both read from /documents, so the headline names the
    // "documents" domain once rather than twice, even though both messages still render.
    expect(alert).toHaveTextContent("Couldn't load: documents, sources");
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('shows exactly one loading region while every fetch is in flight, rather than a skeleton per section', () => {
    stubFetch();

    renderPage();

    // The whole page shares one loading gate, so exactly one status region exists while data is
    // in flight — a skeleton per section would number more than one.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Work queue' })).not.toBeInTheDocument();
  });

  it('renders every section together once the coordinated load resolves, not one at a time', async () => {
    stubFetch();

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Work queue' })).toBeInTheDocument();
    // All three sections come from the same coordinated load, so the instant one has mounted the
    // others are already on screen too, rather than each popping in as its own fetch resolves.
    expect(screen.getByRole('heading', { name: 'Corpus health' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent answers' })).toBeInTheDocument();
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  it('reloads every section from the refresh control, keeping existing content on screen and blocking a second click while busy', async () => {
    let mountResolved = false;
    let resolveApprovalsRefresh: (response: Response) => void = () => {};
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/approvals?limit=5&state=pending') {
        if (!mountResolved) {
          mountResolved = true;
          return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
        }
        return new Promise<Response>((resolve) => {
          resolveApprovalsRefresh = resolve;
        });
      }
      const routes: Record<string, () => Response> = {
        '/api/v1/auth/me': () => jsonResponse(admin),
        '/api/v1/dashboard/summary': () => jsonResponse(summaryHealthy),
        '/api/v1/conflicts?limit=5&status=open': () => jsonResponse({ docs: [], count: 0 }),
        '/api/v1/documents?limit=100&ingestionStatus=failed': () =>
          jsonResponse({ docs: [], count: 0 }),
        '/api/v1/sources?limit=100&lastSyncStatus=failed': () =>
          jsonResponse({ docs: [], count: 0 }),
        '/api/v1/documents?limit=100&ingestionStatus=facts-failed': () =>
          jsonResponse({ docs: [], count: 0 }),
        '/api/v1/answers?limit=5': () => jsonResponse({ docs: [answered], count: 1 }),
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('heading', { name: 'Work queue' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    const busyButton = await screen.findByRole('button', { name: 'Refreshing…' });
    expect(busyButton).toBeDisabled();
    // Already-rendered content stays on screen while the refresh runs rather than the page
    // dropping back behind a skeleton — only the initial load holds that gate.
    expect(screen.getByRole('heading', { name: 'Work queue' })).toBeInTheDocument();

    fireEvent.click(busyButton);

    resolveApprovalsRefresh(jsonResponse({ docs: [approvalPending], count: 1 }));

    expect(
      await screen.findByText('Approve resolving the occupancy rate conflict'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled();

    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/v1/approvals?limit=5&state=pending',
    );
    // One call on mount, one for the refresh — the click while busy fires no extra request.
    expect(refreshCalls).toHaveLength(2);
  });

  it('completes an approval decision inline from the work queue, without navigating away', async () => {
    let currentApprovals = [approvalPending];
    stubFetch({
      approvals: () => jsonResponse({ docs: currentApprovals, count: currentApprovals.length }),
      extraRoutes: {
        '/api/v1/approvals/approval-1/decision': () => {
          currentApprovals = [];
          return jsonResponse({ ...approvalPending, state: 'approved', decidedBy: admin.email });
        },
      },
    });

    renderPage();

    const row = (await screen.findByText('Approve resolving the occupancy rate conflict')).closest(
      'li',
    );
    expect(row).not.toBeNull();
    // The approve/reject controls mount only once `useSession()`'s probe resolves to an admin, and
    // that is a passive effect flushing after the commit that renders the row — so the row being
    // on screen is not evidence the button exists yet.
    fireEvent.click(await within(row as HTMLElement).findByRole('button', { name: 'Approve' }));

    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // Still on Home — the row's own dialog decided the approval, no route change was needed.
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(
      screen.queryByText('Approve resolving the occupancy rate conflict'),
    ).not.toBeInTheDocument();
  });

  it('hides the approve/reject controls in the work queue for a non-admin', async () => {
    stubFetch({
      me: () => jsonResponse(member),
      approvals: () => jsonResponse({ docs: [approvalPending], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText('Approve resolving the occupancy rate conflict')).closest(
      'li',
    );
    expect(row).not.toBeNull();
    // Await the session probe before asserting the controls are absent. Taken any earlier, this
    // assertion passes for an admin too — the row renders before the probe resolves, so "not yet
    // mounted" and "gated off" are indistinguishable and the gate could break without failing.
    await ensureSession();
    await waitFor(() =>
      expect(screen.getByText('Approve resolving the occupancy rate conflict')).toBeInTheDocument(),
    );
    expect(
      within(row as HTMLElement).queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
    expect(
      within(row as HTMLElement).queryByRole('button', { name: 'Reject' }),
    ).not.toBeInTheDocument();
  });

  it('requests resolution on a recommended conflict inline from the work queue', async () => {
    let currentConflicts = [conflictWithRecommendation];
    const fetchMock = stubFetch({
      conflicts: () => jsonResponse({ docs: currentConflicts, count: currentConflicts.length }),
      extraRoutes: {
        '/api/v1/conflicts/conflict-2/resolution-requests': () => {
          currentConflicts = [];
          return jsonResponse({
            id: 'run-1',
            workflowId: 'wf-2',
            status: 'running',
            createdAt: new Date().toISOString(),
          });
        },
      },
    });

    renderPage();

    const row = (await screen.findByText('Northgate — occupancy (2025-03)')).closest('li');
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Request resolution' }));

    const dialog = screen.getByRole('dialog', { name: 'Request resolution' });
    expect(within(dialog).getByText(/92 percent as the winning value/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request resolution' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Northgate — occupancy (2025-03)')).not.toBeInTheDocument();

    const call = fetchMock.mock.calls.find(
      ([url]) => url === '/api/v1/conflicts/conflict-2/resolution-requests',
    );
    expect(call).toBeDefined();
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
      winningFactId: 'fact-3',
    });
  });

  it('leaves no inline resolve control on a conflict with no policy recommendation', async () => {
    stubFetch({
      conflicts: () => jsonResponse({ docs: [conflictOpen], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText('Northgate — occupancy (2025-03)')).closest('li');
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).queryByRole('button', { name: 'Request resolution' }),
    ).not.toBeInTheDocument();
  });

  it('starts a sync inline from corpus health for a failed source', async () => {
    const fetchMock = stubFetch({
      failedSources: () => jsonResponse({ docs: [failingSource], count: 1 }),
      extraRoutes: {
        '/api/v1/sources/source-2/sync': () =>
          jsonResponse({
            id: 'run-3',
            workflowId: 'wf-3',
            status: 'running',
            createdAt: new Date().toISOString(),
          }),
      },
    });

    renderPage();

    const row = (await screen.findByText('Second Source')).closest('li');
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Sync now' }));

    expect(await within(row as HTMLElement).findByText('Syncing…')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.find(([url]) => url === '/api/v1/sources/source-2/sync'),
    ).toBeDefined();
  });

  it("replaces a failed document's version inline from corpus health", async () => {
    let currentFailedDocuments = [documentFailed];
    const fetchMock = stubFetch({
      failedDocuments: () =>
        jsonResponse({ docs: currentFailedDocuments, count: currentFailedDocuments.length }),
      extraRoutes: {
        '/api/v1/documents': () => {
          currentFailedDocuments = [];
          return jsonResponse({
            ...documentFailed,
            currentVersion: {
              ...documentFailed.currentVersion,
              versionNumber: 2,
              ingestionStatus: 'pending',
            },
          });
        },
      },
    });

    renderPage();

    const row = (await screen.findByText('Q3 Financials.xlsx')).closest('li');
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Replace version' }));

    const dialog = screen.getByRole('dialog', { name: 'Replace document version' });
    const file = new File(['updated content'], 'Q3 Financials v2.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    fireEvent.change(within(dialog).getByLabelText('File'), { target: { files: [file] } });

    expect(within(dialog).getByText(/Q3 Financials v2\.xlsx/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Upload' }));

    await waitFor(() => {
      expect(screen.queryByText('Q3 Financials.xlsx')).not.toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.find(([url]) => url === '/api/v1/documents')).toBeDefined();
  });

  it('focuses the file input and shows an inline error on an empty submit, rather than doing nothing', async () => {
    stubFetch({
      failedDocuments: () => jsonResponse({ docs: [documentFailed], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText('Q3 Financials.xlsx')).closest('li');
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Replace version' }));

    const dialog = screen.getByRole('dialog', { name: 'Replace document version' });
    const uploadButton = within(dialog).getByRole('button', { name: 'Upload' });
    // Nothing gates the button on field state — the submit itself runs validation.
    expect(uploadButton).not.toBeDisabled();
    fireEvent.click(uploadButton);

    expect(await within(dialog).findByText('Choose a file to upload.')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText('File')).toHaveFocus());
  });
});
