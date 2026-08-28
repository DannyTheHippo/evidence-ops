import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auth from './auth';
import { usePendingCounts } from './use-pending-counts';

const member = {
  id: 'user-1',
  email: 'member@example.com',
  role: 'member' as const,
  createdAt: new Date().toISOString(),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchStub(
  overrides: { conflictsCount?: number; approvalsCount?: number; approvalsFail?: boolean } = {},
) {
  const { conflictsCount = 0, approvalsCount = 0, approvalsFail = false } = overrides;
  return vi.fn((url: string) => {
    if (url.startsWith('/api/v1/conflicts')) {
      return Promise.resolve(jsonResponse({ docs: [], count: conflictsCount }));
    }
    if (url.startsWith('/api/v1/approvals')) {
      return approvalsFail
        ? Promise.reject(new TypeError('network error'))
        : Promise.resolve(jsonResponse({ docs: [], count: approvalsCount }));
    }
    return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
  });
}

function Harness() {
  const counts = usePendingCounts();
  return (
    <p>
      conflicts: {counts.conflicts === null ? 'null' : counts.conflicts}, approvals:{' '}
      {counts.approvals === null ? 'null' : counts.approvals}
    </p>
  );
}

function NavigateButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(to)}>
      go
    </button>
  );
}

describe('usePendingCounts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    auth.clearSession();
  });

  it('reads count from each response envelope, discarding the rows', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 4, approvalsCount: 1 }));

    render(
      <MemoryRouter initialEntries={['/conflicts']}>
        <Harness />
      </MemoryRouter>,
    );

    expect(await screen.findByText('conflicts: 4, approvals: 1')).toBeInTheDocument();
  });

  it('resolves a failing count to null without affecting the other', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 2, approvalsFail: true }));

    render(
      <MemoryRouter initialEntries={['/conflicts']}>
        <Harness />
      </MemoryRouter>,
    );

    expect(await screen.findByText('conflicts: 2, approvals: null')).toBeInTheDocument();
  });

  it('refetches on a pathname change', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    const fetchMock = fetchStub({ conflictsCount: 1, approvalsCount: 1 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/a']}>
        <NavigateButton to="/b" />
        <Harness />
      </MemoryRouter>,
    );
    await screen.findByText('conflicts: 1, approvals: 1');
    const callsAtA = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAtA);
    });
  });

  it('never fetches while the session is anonymous', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(null);
    const fetchMock = fetchStub({ conflictsCount: 9, approvalsCount: 9 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/a']}>
        <Harness />
      </MemoryRouter>,
    );

    await screen.findByText('conflicts: null, approvals: null');
    // A tick past the resolved (anon) session probe — long enough for a wrongly-gated fetch to
    // have fired — with the counts still untouched confirms usePendingCounts never called either
    // endpoint, not just that it hadn't gotten to it yet.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/v1/conflicts'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/v1/approvals'))).toBe(false);
  });
});
