import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  createdAt: new Date().toISOString(),
};

describe('ApprovalsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists a pending approval showing the conflicting values and their sources', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ docs: [pendingApproval], count: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ApprovalsPage />);

    expect(
      await screen.findByText(
        'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Requested by analyst@example.com')).toBeInTheDocument();
  });

  it('approves a pending approval and removes it from the inbox', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [pendingApproval], count: 1 }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...pendingApproval, state: 'approved', decidedBy: 'reviewer@example.com' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ApprovalsPage />);

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

    render(<ApprovalsPage />);

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
});
