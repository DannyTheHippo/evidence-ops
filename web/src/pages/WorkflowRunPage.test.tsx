import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkflowRunPage from './WorkflowRunPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const runningRun = {
  id: 'run-1',
  workflowId: 'wf-1',
  status: 'running',
  createdAt: new Date().toISOString(),
};

const completedRun = { ...runningRun, status: 'completed' };

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

function renderAt(id: string, pollIntervalMs = 5) {
  render(
    <MemoryRouter initialEntries={[`/workflow-runs/${id}`]}>
      <Routes>
        <Route
          path="/workflow-runs/:id"
          element={<WorkflowRunPage pollIntervalMs={pollIntervalMs} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WorkflowRunPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the run paused awaiting approval, then resumed once the run completes', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse(runningRun));
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [pendingApproval], count: 1 }));
    fetchMock.mockResolvedValueOnce(jsonResponse(completedRun));
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [], count: 0 }));
    fetchMock.mockResolvedValue(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    expect(screen.getByText('Loading…')).toBeInTheDocument();

    expect(await screen.findByText('Paused — awaiting approval')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
      ),
    ).toBeInTheDocument();

    expect(await screen.findByText('Resumed — completed')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('stops polling once the run reaches a terminal status', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse(completedRun));
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('run-1');

    await screen.findByText('completed');

    // Give a poll interval's worth of real time to land, if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
