import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Approval, Conflict } from '../../api/client';
import type { ResolvedVersion } from '../../lib/document-index';
import DecisionCase from './DecisionCase';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const metricLabels: Record<string, string> = { cap_rate: 'Cap rate' };
const documentIndex = new Map<string, ResolvedVersion>();

const pendingApproval: Approval = {
  id: 'approval-1',
  subject: { entityType: 'Conflict', entityId: 'conflict-1' },
  action: 'resolve_conflict',
  summary: 'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
  requestedBy: 'analyst@example.com',
  workflowId: 'wf-1',
  state: 'pending',
  createdAt: '2026-08-01T12:00:00.000Z',
};

const approvedApproval: Approval = {
  ...pendingApproval,
  id: 'approval-2',
  state: 'approved',
  decidedBy: 'reviewer@example.com',
  decidedAt: '2026-08-05T10:15:00.000Z',
  decisionReason: 'Evidence checks out.',
};

const authorityConflict: Conflict = {
  id: 'conflict-1',
  factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
  factIds: ['fact-1', 'fact-2'],
  values: [
    {
      factId: 'fact-1',
      value: 5.25,
      unit: 'percent',
      sourceChunkId: 'chunk-a',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      withdrawn: false,
    },
    {
      factId: 'fact-2',
      value: 6.1,
      unit: 'percent',
      sourceChunkId: 'chunk-b',
      documentVersionId: 'docver-1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 5 },
      withdrawn: false,
    },
  ],
  magnitude: 0.0085,
  magnitudeUnit: 'ratio',
  status: 'open',
  createdAt: '2026-08-01T11:00:00.000Z',
  stale: false,
  unscorable: false,
  proposedWinnerFactId: 'fact-1',
  ruleFired: 'authority',
  explanation: "Source 'chunk-a' outranks the other value's source under the authority policy.",
};

const undecidedConflict: Conflict = {
  ...authorityConflict,
  id: 'conflict-2',
  proposedWinnerFactId: undefined,
  ruleFired: 'none',
  explanation: 'No configured rule distinguishes between these sources.',
};

function renderCase(
  props: Partial<ComponentProps<typeof DecisionCase>> = {},
  fetchMock?: ReturnType<typeof vi.fn>,
) {
  if (fetchMock) vi.stubGlobal('fetch', fetchMock);
  render(
    <MemoryRouter>
      <Routes>
        <Route
          path="/"
          element={
            <DecisionCase
              approval={pendingApproval}
              metricLabels={metricLabels}
              documentIndex={documentIndex}
              canDecide
              sessionResolved
              onDecided={() => {}}
              {...props}
            />
          }
        />
        {/* Static, not :id — pins the assertion to run.id ('run-1'), not approval.workflowId
            ('wf-1'), so a regression to the wrong field fails the test instead of matching
            anything. */}
        <Route path="/workflow-runs/run-1" element={<p>run page probe</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DecisionCase', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the decider and reason for an already-decided approval', () => {
    renderCase({ approval: approvedApproval, canDecide: false });

    expect(screen.getByText('by reviewer@example.com', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Reason')).toBeInTheDocument();
    expect(screen.getByText('Evidence checks out.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('renders the proposal strip and the sourced value compare for a joined conflict', () => {
    renderCase({ conflict: authorityConflict });

    expect(screen.getByText('recommended · authority')).toBeInTheDocument();
    expect(
      screen.getByText(
        "5.25 percent — Source 'chunk-a' outranks the other value's source under the authority policy.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View conflict' })).toHaveAttribute(
      'href',
      '/adjudication?kind=conflicts&selected=conflict-1',
    );
    // The read-only value compare renders both competing values with their sources, and offers
    // no per-value action — deciding lives in the Approve/Reject controls, not the comparison.
    expect(screen.getByText('5.25 percent')).toBeInTheDocument();
    expect(screen.getByText('6.1 percent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request resolution' })).not.toBeInTheDocument();
  });

  it('renders the no-recommendation line instead of a policy strip when the policy declined', () => {
    renderCase({ conflict: undecidedConflict });

    // Twice — the compact `.cell-sub` line and `ConflictValueCompare`'s own strip both state it.
    expect(
      screen.getAllByText(
        'Policy has no recommendation for this conflict — No configured rule distinguishes between these sources.',
      ),
    ).toHaveLength(2);
    expect(screen.queryByText(/^recommended ·/)).not.toBeInTheDocument();
  });

  it('renders nothing conflict-related without a joined conflict', () => {
    renderCase({ conflict: undefined });

    expect(screen.queryByRole('link', { name: 'View conflict' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^recommended ·/)).not.toBeInTheDocument();
  });

  it('an admin sees Approve and Reject on a pending approval', () => {
    renderCase({ canDecide: true, sessionResolved: true });

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByText('Deciding approvals requires an admin.')).not.toBeInTheDocument();
  });

  it('a member sees the admin-only note instead of decide controls', () => {
    renderCase({ canDecide: false, sessionResolved: true });

    expect(screen.getByText('Deciding approvals requires an admin.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('shows neither the controls nor the note while the session is still resolving', () => {
    renderCase({ canDecide: false, sessionResolved: false });

    expect(screen.queryByText('Deciding approvals requires an admin.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('approves with a typed reason, posting both fields and notifying the caller', async () => {
    const onDecided = vi.fn();
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === '/api/v1/approvals/approval-1/decision') {
        return Promise.resolve(
          jsonResponse({ ...pendingApproval, state: 'approved', decidedBy: 'admin@example.com' }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    renderCase({ onDecided }, fetchMock);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this approval' });
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), {
      target: { value: 'Evidence checks out.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(onDecided).toHaveBeenCalledWith('approval-1');

    const decideCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/v1/approvals/approval-1/decision',
    );
    expect(decideCall).toBeDefined();
    expect(JSON.parse((decideCall![1] as RequestInit).body as string)).toEqual({
      decision: 'approved',
      reason: 'Evidence checks out.',
    });
  });

  it('rejects with no reason typed, posting the decision alone', async () => {
    const onDecided = vi.fn();
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === '/api/v1/approvals/approval-1/decision') {
        return Promise.resolve(jsonResponse({ ...pendingApproval, state: 'rejected' }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    renderCase({ onDecided }, fetchMock);

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject this approval' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(onDecided).toHaveBeenCalledWith('approval-1');

    const decideCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/v1/approvals/approval-1/decision',
    );
    expect(decideCall).toBeDefined();
    expect(JSON.parse((decideCall![1] as RequestInit).body as string)).toEqual({
      decision: 'rejected',
    });
  });

  it('navigates to the workflow run when "View run" finds one', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?workflowId=wf-1') {
        return Promise.resolve(
          jsonResponse({
            docs: [
              {
                id: 'run-1',
                workflowId: 'wf-1',
                status: 'running',
                createdAt: pendingApproval.createdAt,
              },
            ],
            count: 1,
          }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    renderCase({}, fetchMock);

    fireEvent.click(screen.getByRole('button', { name: 'View run' }));

    expect(await screen.findByText('run page probe')).toBeInTheDocument();
  });

  it('shows an error when "View run" finds no run for the workflow', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/workflow-runs?workflowId=wf-1') {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    renderCase({}, fetchMock);

    fireEvent.click(screen.getByRole('button', { name: 'View run' }));

    expect(await screen.findByText('No run found for this workflow.')).toBeInTheDocument();
  });
});
