import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApprovalsPage from './ApprovalsPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const pendingApproval = {
  id: 'approval-1',
  subject: { entityType: 'Conflict', entityId: 'conflict-1' },
  action: 'resolve_conflict',
  summary: 'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
  requestedBy: 'analyst@example.com',
  workflowId: 'wf-1',
  state: 'pending',
  createdAt: '2026-08-01T12:00:00.000Z',
};

function renderPage() {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<ApprovalsPage />} />
        {/* Static, not :id — pins the assertion to the run's own id ('run-1'), not
            approval.workflowId ('wf-1'), so a regression to the wrong field fails the test
            instead of matching anything. */}
        <Route path="/workflow-runs/run-1" element={<p>run page probe</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ApprovalsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists a pending approval showing the conflicting values, source, and request timestamp', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ docs: [pendingApproval], count: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(screen.getByText('Loading…')).toBeInTheDocument();

    expect(
      await screen.findByText(
        'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.getByText('Requested by analyst@example.com')).toBeInTheDocument();
    expect(
      screen.getByText(`Requested ${new Date(pendingApproval.createdAt).toLocaleString()}`),
    ).toBeInTheDocument();
  });

  it('approves a pending approval and removes it from the inbox', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [pendingApproval], count: 1 }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...pendingApproval, state: 'approved', decidedBy: 'reviewer@example.com' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await screen.findByRole('button', { name: 'Approve' });
    fireEvent.change(screen.getByLabelText('Reason (optional)'), {
      target: { value: 'Evidence checks out.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    });
    expect(screen.getByText('No pending approvals.')).toBeInTheDocument();

    const [, decideCall] = fetchMock.mock.calls;
    expect(decideCall[0]).toBe('/api/v1/approvals/approval-1/decision');
    expect(JSON.parse((decideCall[1] as RequestInit).body as string)).toEqual({
      decision: 'approved',
      reason: 'Evidence checks out.',
    });
  });

  it('rejects a pending approval and removes it from the inbox', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [pendingApproval], count: 1 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...pendingApproval, state: 'rejected' }));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await screen.findByRole('button', { name: 'Reject' });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    });
    expect(screen.getByText('No pending approvals.')).toBeInTheDocument();

    const [, decideCall] = fetchMock.mock.calls;
    expect(decideCall[0]).toBe('/api/v1/approvals/approval-1/decision');
    expect(JSON.parse((decideCall[1] as RequestInit).body as string)).toEqual({
      decision: 'rejected',
    });
  });

  it('navigates to the workflow run when "View run" finds one', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/approvals') {
        return Promise.resolve(jsonResponse({ docs: [pendingApproval], count: 1 }));
      }
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
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'View run' }));

    expect(await screen.findByText('run page probe')).toBeInTheDocument();
  });

  it('shows an error when "View run" finds no run for the workflow', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/approvals') {
        return Promise.resolve(jsonResponse({ docs: [pendingApproval], count: 1 }));
      }
      if (url === '/api/v1/workflow-runs?workflowId=wf-1') {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'View run' }));

    expect(await screen.findByText('No run found for this workflow.')).toBeInTheDocument();
  });
});
