import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conflict } from '../../api/client';
import type { ResolvedVersion } from '../../lib/document-index';
import ConflictCase from './ConflictCase';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const metricLabels: Record<string, string> = { cap_rate: 'Cap rate' };

const documentIndex = new Map<string, ResolvedVersion>([
  ['docver-1', { documentId: 'doc-1', documentTitle: 'Rent Roll Q1', withdrawn: false }],
]);

const openConflict: Conflict = {
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
  stale: true,
  staleReason: "Detected under pack 'cre' v1; the active pack is now 'cre' v2.",
  unscorable: false,
  proposedWinnerFactId: 'fact-1',
  ruleFired: 'authority',
  explanation: "Source 'chunk-a' outranks the other value's source under the authority policy.",
};

// Three competing values — one recommended, one plain, one withdrawn — the case a two-outcome
// assertion can't distinguish: primary treatment must land on exactly the recommended, non
// withdrawn card.
const threeWayConflict: Conflict = {
  ...openConflict,
  id: 'conflict-2',
  stale: false,
  staleReason: undefined,
  factIds: ['fact-3', 'fact-4', 'fact-5'],
  proposedWinnerFactId: 'fact-3',
  values: [
    {
      factId: 'fact-3',
      value: 6.1,
      unit: 'percent',
      sourceChunkId: 'chunk-c',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 1 },
      withdrawn: false,
    },
    {
      factId: 'fact-4',
      value: 5.4,
      unit: 'percent',
      sourceChunkId: 'chunk-d',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      withdrawn: false,
    },
    {
      factId: 'fact-5',
      value: 7.9,
      unit: 'percent',
      sourceChunkId: 'chunk-e',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 3 },
      withdrawn: true,
    },
  ],
};

// The policy recommended a value whose source has since been withdrawn — no primary should
// render for it, since promoting dead evidence would manufacture a recommendation the system did
// not make.
const withdrawnWinnerConflict: Conflict = {
  ...openConflict,
  id: 'conflict-3',
  stale: false,
  staleReason: undefined,
  factIds: ['fact-6', 'fact-7'],
  proposedWinnerFactId: 'fact-6',
  values: [
    {
      factId: 'fact-6',
      value: 6.1,
      unit: 'percent',
      sourceChunkId: 'chunk-f',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 1 },
      withdrawn: true,
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
  ],
};

// No rule distinguishes the two sources — no primary should render for either.
const undecidedConflict: Conflict = {
  ...openConflict,
  id: 'conflict-4',
  stale: false,
  staleReason: undefined,
  proposedWinnerFactId: undefined,
  ruleFired: 'none',
  explanation: 'No configured rule distinguishes between these sources.',
};

// Open, but the evidence behind it no longer resolves — the request endpoint answers 500 for this
// row, so the pane must offer no action to send.
const unscorableConflict: Conflict = {
  ...openConflict,
  id: 'conflict-7',
  stale: false,
  staleReason: undefined,
  unscorable: true,
  unscorableReason: '1 of 2 disagreeing fact(s) no longer resolve to an ExtractedFact.',
  proposedWinnerFactId: undefined,
  ruleFired: undefined,
  explanation: undefined,
};

// Resolved with no `resolution` record — data written before Phase 3B started persisting one, or
// an older row the timeout branch decided without a full record landing yet.
const resolvedNoRecordConflict: Conflict = {
  ...openConflict,
  id: 'conflict-5',
  status: 'resolved',
  stale: false,
  staleReason: undefined,
};

const decidedConflict: Conflict = {
  ...openConflict,
  id: 'conflict-6',
  status: 'resolved',
  stale: false,
  staleReason: undefined,
  resolution: {
    outcome: 'resolved',
    winningFactId: 'fact-1',
    decidedBy: 'admin@example.com',
    reason: 'Evidence checks out.',
    resolvedAt: '2026-08-05T10:15:00.000Z',
    ruleFired: 'authority',
    followedProposal: true,
  },
};

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current location">{location.pathname}</output>;
}

function renderCase(
  conflict: Conflict,
  fetchMock?: ReturnType<typeof vi.fn>,
  pendingApprovalId?: string,
) {
  if (fetchMock) vi.stubGlobal('fetch', fetchMock);
  render(
    <MemoryRouter>
      <Routes>
        <Route
          path="/"
          element={
            <ConflictCase
              conflict={conflict}
              metricLabels={metricLabels}
              documentIndex={documentIndex}
              pendingApprovalId={pendingApprovalId}
            />
          }
        />
        {/* Static, not :id — pins the assertion to run.id ('run-1'), not run.workflowId
            ('wf-1'), so a regression to the wrong field fails the test instead of matching
            anything. */}
        <Route path="/workflow-runs/run-1" element={<p>run page probe</p>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('ConflictCase', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the entity, resolved metric label, spread, and a stale notice', () => {
    renderCase(openConflict);

    expect(screen.getByRole('heading', { name: 'Northgate Business Park' })).toBeInTheDocument();
    expect(screen.getByText('Cap rate · 2025-03')).toBeInTheDocument();
    expect(screen.getByText('0.0085 ratio')).toBeInTheDocument();
    expect(
      screen.getByText("Detected under pack 'cre' v1; the active pack is now 'cre' v2."),
    ).toBeInTheDocument();
  });

  it('groups thousands in the spread and the resolution confirmation without changing a small value', async () => {
    const largeSpreadConflict: Conflict = {
      ...openConflict,
      id: 'conflict-8',
      magnitude: 1250000,
      magnitudeUnit: 'sqft',
      values: [{ ...openConflict.values[0], value: 720000, unit: 'usd' }],
    };
    renderCase(largeSpreadConflict);

    expect(screen.getByText('1,250,000 sqft')).toBeInTheDocument();
    expect(screen.getByText('720,000 usd')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Request resolution' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request resolution' });

    expect(
      within(dialog).getByText(
        'Request resolution using 720,000 usd as the winning value? This starts a workflow run that needs approval.',
      ),
    ).toBeInTheDocument();
  });

  it('offers a primary resolve action on the recommended card only, secondary on every other', () => {
    renderCase(threeWayConflict);

    const resolveButtons = screen.getAllByRole('button', { name: 'Request resolution' });
    expect(resolveButtons).toHaveLength(3);
    expect(resolveButtons[0]).toHaveClass('btn--primary');
    expect(resolveButtons[1]).toHaveClass('btn--secondary');
    expect(resolveButtons[2]).toHaveClass('btn--secondary');
  });

  it('offers no primary resolve action when the recommended value has been withdrawn', () => {
    renderCase(withdrawnWinnerConflict);

    const resolveButtons = screen.getAllByRole('button', { name: 'Request resolution' });
    expect(resolveButtons).toHaveLength(2);
    expect(resolveButtons.some((button) => button.classList.contains('btn--primary'))).toBe(false);
  });

  it('offers no primary resolve action when the policy has no recommendation', () => {
    renderCase(undecidedConflict);

    const resolveButton = screen.getByRole('button', { name: 'Request resolution' });
    expect(resolveButton).toHaveClass('btn--secondary');
    expect(resolveButton).not.toHaveClass('btn--primary');
  });

  it('offers no resolution action on an unscorable conflict and says why', () => {
    renderCase(unscorableConflict);

    expect(screen.queryByRole('button', { name: 'Request resolution' })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Not resolvable while its evidence is missing — restore the missing evidence, or dismiss the conflict.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('1 of 2 disagreeing fact(s) no longer resolve to an ExtractedFact.'),
    ).toBeInTheDocument();
  });

  it('says a resolution is already pending and links to the decision', () => {
    renderCase(openConflict, undefined, 'approval-9');

    expect(screen.getByText('Resolution pending — awaiting approval.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the decision' })).toHaveAttribute(
      'href',
      '/adjudication?kind=decisions&state=pending&selected=approval-9',
    );
    expect(screen.queryByRole('button', { name: 'Request resolution' })).not.toBeInTheDocument();
  });

  it('surfaces a resolution failure in the pane when the dialog was dismissed first', async () => {
    let settle: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    renderCase(openConflict, fetchMock);

    fireEvent.click(screen.getByRole('button', { name: 'Request resolution' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request resolution' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request resolution' }));
    // Dismissed while the request is still in flight — the header close control stays live under
    // `busy`, where Cancel is disabled.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    settle(jsonResponse({ message: 'Fact already resolved' }, 409));

    expect(await screen.findByRole('alert')).toHaveTextContent('Fact already resolved');
  });

  it('requests a resolution on confirm and navigates to the started run', async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === '/api/v1/conflicts/conflict-1/resolution-requests') {
        return Promise.resolve(
          jsonResponse({
            id: 'run-1',
            workflowId: 'wf-1',
            status: 'running',
            createdAt: new Date().toISOString(),
          }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    renderCase(openConflict, fetchMock);

    fireEvent.click(screen.getByRole('button', { name: 'Request resolution' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request resolution' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request resolution' }));

    expect(await screen.findByText('run page probe')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'current location' })).toHaveTextContent(
      '/workflow-runs/run-1',
    );

    const resolutionCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/v1/conflicts/conflict-1/resolution-requests',
    );
    expect(resolutionCall).toBeDefined();
    expect(JSON.parse((resolutionCall![1] as RequestInit).body as string)).toEqual({
      winningFactId: 'fact-1',
    });
  });

  it('keeps the dialog open with the request error when the resolution request fails', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ message: 'Fact already resolved' }, 409)),
    );
    renderCase(openConflict, fetchMock);

    fireEvent.click(screen.getByRole('button', { name: 'Request resolution' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request resolution' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request resolution' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Fact already resolved');
    expect(screen.getByRole('dialog', { name: 'Request resolution' })).toBeInTheDocument();
  });

  it('renders no action buttons and "Recorded under Decisions." for a resolved conflict with no resolution record', () => {
    renderCase(resolvedNoRecordConflict);

    expect(screen.getByText('Recorded under Decisions.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request resolution' })).not.toBeInTheDocument();
  });

  it('renders the decision outcome, decider, reason, rule fired and whether the proposal was followed', () => {
    renderCase(decidedConflict);

    expect(
      screen.getByText('resolved by admin@example.com on', { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText('Evidence checks out.')).toBeInTheDocument();
    expect(screen.getByText('rule fired · authority')).toBeInTheDocument();
    expect(screen.getByText('followed the proposal')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request resolution' })).not.toBeInTheDocument();
  });
});
