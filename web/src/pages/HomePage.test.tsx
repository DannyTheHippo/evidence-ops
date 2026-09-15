import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, ensureSession } from '../lib/auth';
import { clearToasts, getToasts } from '../components/ui/toast';
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

// No workflowId — an approval created outside a workflow, unlike approvalPending below.
const approvalNoWorkflow = {
  id: 'approval-2',
  subject: { entityType: 'Conflict', entityId: 'conflict-8' },
  action: 'resolve-conflict',
  summary: 'Approve resolving the vacancy rate conflict',
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

// `proposedWinnerFactId` names a fact no entry in `values` carries — the shape a withdrawn or
// otherwise-vanished recommendation leaves behind, which must not surface the inline control.
const conflictWithDanglingRecommendation = {
  ...conflictWithRecommendation,
  id: 'conflict-3',
  proposedWinnerFactId: 'fact-missing',
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

function renderPage(initialEntries?: string[]) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <HomePage />
    </MemoryRouter>,
  );
}

// Drives the fake clock and lets each fetch settle through its response-parsing promise chain, so
// assertions read committed state instead of racing it — mirrors SourcesPage.test.tsx's helper of
// the same name.
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('HomePage', () => {
  // jsdom implements no scrollIntoView at all; the hash-focus effect calls it unguarded, since
  // every real browser has it. What is saved and put back is the property descriptor, not the
  // method value — the prototype is left exactly as this file found it, with no property at all
  // where jsdom defines none.
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollIntoView',
  );
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    // `restoreAllMocks` leaves a `vi.fn()`'s call history alone, so it is cleared here or the
    // hash test reads calls made by an earlier test.
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // useSession() shares auth.ts's module-level session cache; without this, whichever role
    // the first test in this file probes for would leak into every later test.
    clearSession();
    clearToasts();
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
      '/#corpus-health',
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

  it('renders a retryable alert when the dashboard summary fails, instead of four silent dashes', async () => {
    const fetchMock = stubFetch({
      summary: () => jsonResponse({ message: 'Summary service unavailable' }, 500),
    });

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load the dashboard summary");
    expect(alert).toHaveTextContent('Summary service unavailable');

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      const summaryCalls = fetchMock.mock.calls.filter(
        ([url]) => url === '/api/v1/dashboard/summary',
      );
      expect(summaryCalls).toHaveLength(2);
    });
  });

  it('links the corpus-failures figure at the in-page section and moves focus there on the hash', async () => {
    stubFetch();

    renderPage(['/#corpus-health']);

    const heading = await screen.findByRole('heading', { name: 'Corpus health' });
    expect(screen.getByRole('link', { name: /Corpus failures/ })).toHaveAttribute(
      'href',
      '/#corpus-health',
    );
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    await waitFor(() => expect(section).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalled();
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
      '/adjudication?kind=conflicts&status=open&selected=conflict-1',
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
    // Truncated in the row, so keyboard focus on it opens the full reason.
    const documentDetail = screen.getByText('XLSX parse failed: corrupt workbook');
    expect(documentDetail).toHaveAttribute('tabindex', '0');
    documentDetail.focus();
    const documentDetailTooltip = await screen.findByRole('tooltip');
    expect(documentDetailTooltip).toHaveTextContent('XLSX parse failed: corrupt workbook');
    expect(documentDetail).toHaveAttribute('aria-describedby', documentDetailTooltip.id);
    documentDetail.blur();
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    expect(screen.getByText('Ingestion failed')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Second Source' })).toHaveAttribute(
      'href',
      '/sources/source-2',
    );
    const sourceDetail = screen.getByText('Permission denied listing /deal-room');
    expect(sourceDetail).toHaveAttribute('tabindex', '0');
    sourceDetail.focus();
    const sourceDetailTooltip = await screen.findByRole('tooltip');
    expect(sourceDetailTooltip).toHaveTextContent('Permission denied listing /deal-room');
    expect(sourceDetail).toHaveAttribute('aria-describedby', sourceDetailTooltip.id);
    // The label is `sourceStatus()`'s own vocabulary, shared with the Sources pages — its tone is
    // `caution`, not `rejected`: the evidence sits with the connector waiting on a retry, unlike
    // an ingestion failure where it never landed at all.
    expect(screen.getByText('Sync failed').className).toContain('badge--possible');

    // documentOk and sourceOk both ingested/synced cleanly and must not appear as failures.
    expect(screen.queryByText('Lease Agreement.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText('Deal Room Inbox')).not.toBeInTheDocument();
  });

  it('links the ingestion and facts breakdown numbers at their own filtered lists', async () => {
    stubFetch({
      summary: () =>
        jsonResponse({
          ...summaryHealthy,
          ingestionFailedCount: 2,
          syncFailedCount: 1,
          factsFailedCount: 3,
        }),
    });

    renderPage();

    const heading = await screen.findByRole('heading', { name: 'Corpus health' });
    const card = heading.closest('section');
    expect(card).not.toBeNull();

    expect(within(card as HTMLElement).getByRole('link', { name: '2 ingestion' })).toHaveAttribute(
      'href',
      '/documents?ingestionStatus=failed',
    );
    expect(within(card as HTMLElement).getByRole('link', { name: '3 no facts' })).toHaveAttribute(
      'href',
      '/documents?ingestionStatus=facts-failed',
    );
    // The sync figure stays plain text — SourcesPage has no failure filter to deep-link, so
    // linking it would repeat the "link does not match what it claims" defect this line fixes.
    expect(card).toHaveTextContent('1 sync');
    expect(
      within(card as HTMLElement).queryByRole('link', { name: /sync/ }),
    ).not.toBeInTheDocument();
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
    expect(within(connectStep as HTMLElement).getByText('Done')).toBeInTheDocument();
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

  it('sends a member to document upload rather than the admin-only source form', async () => {
    stubFetch({
      me: () => jsonResponse(member),
      summary: () =>
        jsonResponse({ ...summaryHealthy, documentCount: 0, sourceCount: 0, answerCount: 0 }),
      answers: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    const connectStep = (await screen.findByText('Add a source or upload a document')).closest(
      'li',
    );
    expect(connectStep).not.toBeNull();
    // Awaits the session probe before asserting the destination — before it resolves, the step
    // renders toward its closed-direction default, which is this same member destination, so an
    // early assertion here would pass even if the branch were missing entirely.
    await ensureSession();
    const link = await within(connectStep as HTMLElement).findByRole('link', {
      name: 'Upload a document',
    });
    expect(link).toHaveAttribute('href', '/documents');
  });

  it('renders the first-run checklist above the work queue while the funnel is incomplete', async () => {
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

    await screen.findByRole('heading', { name: 'Get started' });
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings.indexOf('Get started')).toBeLessThan(headings.indexOf('Work queue'));
  });

  it('offers a view-all link once the server count exceeds the rows shown', async () => {
    stubFetch({
      approvals: () => jsonResponse({ docs: [approvalPending], count: 4 }),
      answers: () => jsonResponse({ docs: [answered], count: 3 }),
    });

    renderPage();

    const approvalsMore = await screen.findByRole('link', {
      name: 'View all 4 pending approvals',
    });
    expect(approvalsMore).toHaveAttribute('href', '/adjudication?kind=decisions&state=pending');
    expect(
      screen.queryByRole('link', { name: /View all \d+ open conflicts/ }),
    ).not.toBeInTheDocument();

    const answersMore = screen.getByRole('link', { name: 'View all 3 answers' });
    expect(answersMore).toHaveAttribute('href', '/answers');
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
    // Conflicts resolved with zero rows while approvals failed — the queue must not read that
    // resolved-empty leg as "nothing needs your attention" beside a failure it never recovered.
    expect(screen.queryByText('Nothing needs your attention')).not.toBeInTheDocument();

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

  it('keeps the corpus-health empty state off screen while one of its three legs failed', async () => {
    stubFetch({
      failedSources: () => jsonResponse({ message: 'Sources service unavailable' }, 500),
    });

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load: sources");
    expect(screen.queryByText('No ingestion, extraction or sync failures')).not.toBeInTheDocument();
  });

  it('shows exactly one loading region while every fetch is in flight, rather than a skeleton per section', () => {
    stubFetch();

    renderPage();

    // The whole page shares one loading gate, so exactly one status region exists while data is
    // in flight — a skeleton per section would number more than one.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Work queue' })).not.toBeInTheDocument();
  });

  it('renders exactly one loading region composed from the Skeleton primitive', () => {
    stubFetch();

    renderPage();

    const status = screen.getByRole('status');
    expect(status).toHaveClass('skeleton');
    expect(status).toHaveTextContent('Loading your dashboard…');
    // Four fields, one per stat the row shows once loaded, laid out on the stat row's own grid by
    // the .dashboard-skeleton wrapper.
    const shimmer = status.querySelector('[aria-hidden="true"]');
    expect(shimmer).toHaveClass('skeleton-form');
    expect(shimmer?.querySelectorAll('.skeleton-field')).toHaveLength(4);
    const wrapper = status.closest('.dashboard-skeleton');
    expect(wrapper).not.toBeNull();
    // The three card frames below the stats carry no live region of their own — the single status
    // region above is the whole page's loading announcement.
    expect(wrapper?.querySelectorAll('.card[aria-hidden="true"]')).toHaveLength(3);
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
    expect(busyButton).toHaveAttribute('aria-busy', 'true');
    // Already-rendered content stays on screen while the refresh runs rather than the page
    // dropping back behind a skeleton — only the initial load holds that gate.
    expect(screen.getByRole('heading', { name: 'Work queue' })).toBeInTheDocument();

    fireEvent.click(busyButton);

    resolveApprovalsRefresh(jsonResponse({ docs: [approvalPending], count: 1 }));

    expect(
      await screen.findByText('Approve resolving the occupancy rate conflict'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-busy');

    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/v1/approvals?limit=5&state=pending',
    );
    // One call on mount, one for the refresh — the click while busy fires no extra request.
    expect(refreshCalls).toHaveLength(2);
  });

  it('drops a superseded load, so a slow refresh never restores a decided row', async () => {
    let currentApprovals = [approvalPending];
    let approvalsCallCount = 0;
    let resolveStaleApprovals: (response: Response) => void = () => {};

    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/approvals?limit=5&state=pending') {
        approvalsCallCount += 1;
        // The second call is the refresh triggered below; holding it open lets a third, newer
        // load (the decision's own `onChanged`) resolve and settle first.
        if (approvalsCallCount === 2) {
          return new Promise<Response>((resolve) => {
            resolveStaleApprovals = resolve;
          });
        }
        return Promise.resolve(
          jsonResponse({ docs: currentApprovals, count: currentApprovals.length }),
        );
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
        '/api/v1/approvals/approval-1/decision': () => {
          currentApprovals = [];
          return jsonResponse({ ...approvalPending, state: 'approved', decidedBy: admin.email });
        },
      };
      const handler = routes[url];
      if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    const row = (await screen.findByText('Approve resolving the occupancy rate conflict')).closest(
      'li',
    );
    expect(row).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('button', { name: 'Refreshing…' });

    fireEvent.click(
      await within(row as HTMLElement).findByRole('button', {
        name: 'Approve, Approve resolving the occupancy rate conflict',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(
        screen.queryByText('Approve resolving the occupancy rate conflict'),
      ).not.toBeInTheDocument();
    });

    // The stale refresh resolves last, carrying the pre-decision data — it must not restore the
    // row the newer, decision-triggered load already cleared.
    resolveStaleApprovals(jsonResponse({ docs: [approvalPending], count: 1 }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-busy'),
    );
    expect(
      screen.queryByText('Approve resolving the occupancy rate conflict'),
    ).not.toBeInTheDocument();
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
    fireEvent.click(
      await within(row as HTMLElement).findByRole('button', {
        name: 'Approve, Approve resolving the occupancy rate conflict',
      }),
    );

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

  it('moves focus to the section heading after an inline decision removes the row', async () => {
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

    const heading = await screen.findByRole('heading', { name: 'Work queue' });
    const row = (await screen.findByText('Approve resolving the occupancy rate conflict')).closest(
      'li',
    );
    expect(row).not.toBeNull();
    fireEvent.click(
      await within(row as HTMLElement).findByRole('button', {
        name: 'Approve, Approve resolving the occupancy rate conflict',
      }),
    );

    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(
        screen.queryByText('Approve resolving the occupancy rate conflict'),
      ).not.toBeInTheDocument();
    });
    // The reload removed the Approve button the dialog was opened from — the heading is what
    // survives it.
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('says the decision was recorded, not that a workflow resumes, for an approval with no workflowId', async () => {
    let currentApprovals = [approvalNoWorkflow];
    stubFetch({
      approvals: () => jsonResponse({ docs: currentApprovals, count: currentApprovals.length }),
      extraRoutes: {
        '/api/v1/approvals/approval-2/decision': () => {
          currentApprovals = [];
          return jsonResponse({ ...approvalNoWorkflow, state: 'approved', decidedBy: admin.email });
        },
      },
    });

    renderPage();

    const row = (await screen.findByText('Approve resolving the vacancy rate conflict')).closest(
      'li',
    );
    expect(row).not.toBeNull();
    fireEvent.click(
      await within(row as HTMLElement).findByRole('button', {
        name: 'Approve, Approve resolving the vacancy rate conflict',
      }),
    );

    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(getToasts()).toContainEqual(
      expect.objectContaining({
        kind: 'success',
        message: 'Approved — the decision was recorded.',
      }),
    );
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
      within(row as HTMLElement).queryByRole('button', {
        name: 'Approve, Approve resolving the occupancy rate conflict',
      }),
    ).not.toBeInTheDocument();
    expect(
      within(row as HTMLElement).queryByRole('button', {
        name: 'Reject, Approve resolving the occupancy rate conflict',
      }),
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
    fireEvent.click(
      within(row as HTMLElement).getByRole('button', {
        name: 'Request resolution, Northgate — occupancy (2025-03)',
      }),
    );

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
      within(row as HTMLElement).queryByRole('button', {
        name: 'Request resolution, Northgate — occupancy (2025-03)',
      }),
    ).not.toBeInTheDocument();
  });

  it('leaves no inline resolve control on a conflict whose recommended winner is not among its values', async () => {
    stubFetch({
      conflicts: () => jsonResponse({ docs: [conflictWithDanglingRecommendation], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText('Northgate — occupancy (2025-03)')).closest('li');
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).queryByRole('button', {
        name: 'Request resolution, Northgate — occupancy (2025-03)',
      }),
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
    fireEvent.click(
      within(row as HTMLElement).getByRole('button', { name: 'Sync now, Second Source' }),
    );

    expect(await within(row as HTMLElement).findByText('Syncing…')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.find(([url]) => url === '/api/v1/sources/source-2/sync'),
    ).toBeDefined();
  });

  it('clears a synced source from corpus health once the sweep settles', async () => {
    vi.useFakeTimers();
    // Emptied the instant the sync starts, not on the poll response — the row's disappearance
    // must come from the settled sweep's own reload, not from this route happening to already
    // reflect the outcome.
    let currentFailedSources = [failingSource];
    const requestedAt = Date.now();
    const fetchMock = stubFetch({
      failedSources: () =>
        jsonResponse({ docs: currentFailedSources, count: currentFailedSources.length }),
      extraRoutes: {
        '/api/v1/sources/source-2/sync': () => {
          currentFailedSources = [];
          return jsonResponse({
            id: 'run-3',
            workflowId: 'wf-3',
            status: 'running',
            createdAt: new Date().toISOString(),
          });
        },
        '/api/v1/sources/source-2': () =>
          jsonResponse({
            ...sourceOk,
            id: 'source-2',
            lastSyncStatus: 'ok',
            lastSyncAt: new Date(requestedAt + 1000).toISOString(),
            fileStates: [],
          }),
      },
    });

    renderPage();
    await tick();

    const row = screen.getByText('Second Source').closest('li');
    expect(row).not.toBeNull();
    fireEvent.click(
      within(row as HTMLElement).getByRole('button', { name: 'Sync now, Second Source' }),
    );
    await tick();

    // Advances past the hook's 1500 ms poll interval so its first read finds the sweep settled.
    await tick(1500);
    await tick();

    expect(fetchMock.mock.calls.find(([url]) => url === '/api/v1/sources/source-2')).toBeDefined();
    expect(screen.queryByText('Second Source')).not.toBeInTheDocument();
    expect(screen.getByText('No ingestion, extraction or sync failures')).toBeInTheDocument();
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
    fireEvent.click(
      within(row as HTMLElement).getByRole('button', {
        name: 'Replace version, Q3 Financials.xlsx',
      }),
    );

    const dialog = screen.getByRole('dialog', { name: 'Replace document version' });
    const picker = within(dialog).getByLabelText('File', { selector: 'input' });
    expect(picker).toHaveAttribute('type', 'file');
    expect(picker).toHaveAccessibleName('File');
    expect(picker).not.toHaveAttribute('multiple');
    expect(picker).toHaveAttribute(
      'accept',
      '.pdf,.docx,.xlsx,.pptx,.csv,.tsv,.txt,.md,.eml,.html,.htm',
    );

    const file = new File(['updated content'], 'Q3 Financials v2.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    fireEvent.change(picker, { target: { files: [file] } });

    expect(within(dialog).getByText(/Q3 Financials v2\.xlsx/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Upload' }));

    await waitFor(() => {
      expect(screen.queryByText('Q3 Financials.xlsx')).not.toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/v1/documents')).toHaveLength(1);
  });

  it('focuses the file input and shows an inline error on an empty submit, rather than doing nothing', async () => {
    stubFetch({
      failedDocuments: () => jsonResponse({ docs: [documentFailed], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText('Q3 Financials.xlsx')).closest('li');
    expect(row).not.toBeNull();
    fireEvent.click(
      within(row as HTMLElement).getByRole('button', {
        name: 'Replace version, Q3 Financials.xlsx',
      }),
    );

    const dialog = screen.getByRole('dialog', { name: 'Replace document version' });
    const uploadButton = within(dialog).getByRole('button', { name: 'Upload' });
    // Nothing gates the button on field state — the submit itself runs validation.
    expect(uploadButton).not.toHaveAttribute('aria-busy');
    fireEvent.click(uploadButton);

    expect(await within(dialog).findByText('Choose a file to upload.')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByLabelText('File', { selector: 'input' })).toHaveFocus(),
    );
  });

  it('starts a clean replace-version form on every open, with no error from the previous attempt', async () => {
    stubFetch({
      failedDocuments: () => jsonResponse({ docs: [documentFailed], count: 1 }),
      factsFailedDocuments: () => jsonResponse({ docs: [documentFactsFailed], count: 1 }),
      extraRoutes: {
        '/api/v1/documents': () => jsonResponse({ message: 'Upload failed' }, 500),
      },
    });

    renderPage();

    const failedRow = (await screen.findByText('Q3 Financials.xlsx')).closest('li');
    expect(failedRow).not.toBeNull();
    fireEvent.click(
      within(failedRow as HTMLElement).getByRole('button', {
        name: 'Replace version, Q3 Financials.xlsx',
      }),
    );

    let dialog = screen.getByRole('dialog', { name: 'Replace document version' });
    const file = new File(['content'], 'update.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    fireEvent.change(within(dialog).getByLabelText('File', { selector: 'input' }), {
      target: { files: [file] },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Upload' }));

    expect(await within(dialog).findByText('Upload failed')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const otherRow = (await screen.findByText('Northgate Rent Roll.xlsx')).closest('li');
    expect(otherRow).not.toBeNull();
    fireEvent.click(
      within(otherRow as HTMLElement).getByRole('button', {
        name: 'Replace version, Northgate Rent Roll.xlsx',
      }),
    );

    dialog = screen.getByRole('dialog', { name: 'Replace document version' });
    expect(within(dialog).queryByText('Upload failed')).not.toBeInTheDocument();
  });

  it('refuses an unsupported extension before any request is made', async () => {
    const fetchMock = stubFetch({
      failedDocuments: () => jsonResponse({ docs: [documentFailed], count: 1 }),
    });

    renderPage();

    const row = (await screen.findByText('Q3 Financials.xlsx')).closest('li');
    expect(row).not.toBeNull();
    fireEvent.click(
      within(row as HTMLElement).getByRole('button', {
        name: 'Replace version, Q3 Financials.xlsx',
      }),
    );

    const dialog = screen.getByRole('dialog', { name: 'Replace document version' });
    const picker = within(dialog).getByLabelText('File', { selector: 'input' });
    const file = new File(['content'], 'malware.exe', { type: 'application/octet-stream' });
    fireEvent.change(picker, { target: { files: [file] } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Upload' }));

    expect(await within(dialog).findByText('Unsupported file type.')).toBeInTheDocument();
    expect(picker).toHaveAttribute('aria-invalid', 'true');
    expect(picker).toHaveAccessibleDescription(expect.stringContaining('Unsupported file type.'));
    await waitFor(() => expect(picker).toHaveFocus());
    expect(fetchMock.mock.calls.find(([url]) => url === '/api/v1/documents')).toBeUndefined();
  });
});
