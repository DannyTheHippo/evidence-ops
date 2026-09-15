import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auth from './auth';
import { invalidatePendingCounts, usePendingCounts } from './use-pending-counts';

// Resolves on demand, so a test can control which of two overlapping load() calls settles first.
function deferredJsonResponse<T>(): { promise: Promise<Response>; resolve: (body: T) => void } {
  let resolve!: (body: T) => void;
  const promise = new Promise<Response>((res) => {
    resolve = (body: T) => res(jsonResponse(body));
  });
  return { promise, resolve };
}

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
  overrides: {
    conflictsCount?: number;
    approvalsCount?: number;
    approvalsFail?: boolean;
    measuresCount?: number;
    measuresFail?: boolean;
  } = {},
) {
  const {
    conflictsCount = 0,
    approvalsCount = 0,
    approvalsFail = false,
    measuresCount = 0,
    measuresFail = false,
  } = overrides;
  return vi.fn((url: string) => {
    if (url.startsWith('/api/v1/conflicts')) {
      return Promise.resolve(jsonResponse({ docs: [], count: conflictsCount }));
    }
    if (url.startsWith('/api/v1/approvals')) {
      return approvalsFail
        ? Promise.reject(new TypeError('network error'))
        : Promise.resolve(jsonResponse({ docs: [], count: approvalsCount }));
    }
    if (url.startsWith('/api/v1/measures')) {
      return measuresFail
        ? Promise.reject(new TypeError('network error'))
        : Promise.resolve(jsonResponse({ docs: [], count: measuresCount }));
    }
    return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
  });
}

function Harness() {
  const counts = usePendingCounts();
  return (
    <p>
      conflicts: {counts.conflicts === null ? 'null' : counts.conflicts}, approvals:{' '}
      {counts.approvals === null ? 'null' : counts.approvals}, measures:{' '}
      {counts.measures === null ? 'null' : counts.measures}
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
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 4, approvalsCount: 1, measuresCount: 3 }));

    render(
      <MemoryRouter initialEntries={['/adjudication']}>
        <Harness />
      </MemoryRouter>,
    );

    expect(await screen.findByText('conflicts: 4, approvals: 1, measures: 3')).toBeInTheDocument();
  });

  it('resolves a failing count to null without affecting the others', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 2, approvalsFail: true, measuresCount: 3 }));

    render(
      <MemoryRouter initialEntries={['/adjudication']}>
        <Harness />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('conflicts: 2, approvals: null, measures: 3'),
    ).toBeInTheDocument();
  });

  it('resolves only the measures count to null when its fetch fails, without affecting the others', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    vi.stubGlobal('fetch', fetchStub({ conflictsCount: 2, approvalsCount: 1, measuresFail: true }));

    render(
      <MemoryRouter initialEntries={['/adjudication']}>
        <Harness />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('conflicts: 2, approvals: 1, measures: null'),
    ).toBeInTheDocument();
  });

  it('refetches on a pathname change', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    const fetchMock = fetchStub({ conflictsCount: 1, approvalsCount: 1, measuresCount: 1 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/a']}>
        <NavigateButton to="/b" />
        <Harness />
      </MemoryRouter>,
    );
    await screen.findByText('conflicts: 1, approvals: 1, measures: 1');
    const callsAtA = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAtA);
    });
  });

  it('never fetches while the session is anonymous', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(null);
    const fetchMock = fetchStub({ conflictsCount: 9, approvalsCount: 9, measuresCount: 9 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/a']}>
        <Harness />
      </MemoryRouter>,
    );

    await screen.findByText('conflicts: null, approvals: null, measures: null');
    // A tick past the resolved (anon) session probe — long enough for a wrongly-gated fetch to
    // have fired — with the counts still untouched confirms usePendingCounts never called any of
    // the three endpoints, not just that it hadn't gotten to them yet.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/v1/conflicts'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/v1/approvals'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/v1/measures'))).toBe(false);
  });

  it('refetches when invalidatePendingCounts() is published', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    const fetchMock = fetchStub({ conflictsCount: 1, approvalsCount: 1, measuresCount: 1 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/adjudication']}>
        <Harness />
      </MemoryRouter>,
    );
    await screen.findByText('conflicts: 1, approvals: 1, measures: 1');
    const callsAtMount = fetchMock.mock.calls.length;

    invalidatePendingCounts();

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAtMount);
    });
  });

  it('refetches when the document becomes visible', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    const fetchMock = fetchStub({ conflictsCount: 1, approvalsCount: 1, measuresCount: 1 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/adjudication']}>
        <Harness />
      </MemoryRouter>,
    );
    await screen.findByText('conflicts: 1, approvals: 1, measures: 1');
    const callsAtMount = fetchMock.mock.calls.length;

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    fireEvent(document, new Event('visibilitychange'));

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAtMount);
    });
  });

  it('shares one fetch triplet between two mounted consumers, and both see fresh counts after an invalidation', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    const fetchMock = fetchStub({ conflictsCount: 1, approvalsCount: 2, measuresCount: 3 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/adjudication']}>
        <Harness />
        <Harness />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText('conflicts: 1, approvals: 2, measures: 3')).toHaveLength(2);
    });
    // One instance's own fetch loop would already report three calls; two independent loops
    // would report six.
    expect(fetchMock.mock.calls).toHaveLength(3);

    fetchMock.mockImplementation(
      fetchStub({ conflictsCount: 9, approvalsCount: 8, measuresCount: 7 }),
    );
    const callsBeforeInvalidation = fetchMock.mock.calls.length;

    invalidatePendingCounts();

    await waitFor(() => {
      expect(screen.getAllByText('conflicts: 9, approvals: 8, measures: 7')).toHaveLength(2);
    });
    expect(fetchMock.mock.calls.length - callsBeforeInvalidation).toBe(3);
  });

  it('keeps the last counts on screen across a route change instead of blanking them while the refetch is pending', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    const deferred = deferredJsonResponse<{ docs: unknown[]; count: number }>();
    let conflictsCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/v1/conflicts')) {
        conflictsCalls += 1;
        return conflictsCalls === 1
          ? Promise.resolve(jsonResponse({ docs: [], count: 1 }))
          : deferred.promise;
      }
      if (url.startsWith('/api/v1/approvals')) {
        return Promise.resolve(jsonResponse({ docs: [], count: 1 }));
      }
      if (url.startsWith('/api/v1/measures')) {
        return Promise.resolve(jsonResponse({ docs: [], count: 1 }));
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/a']}>
        <NavigateButton to="/b" />
        <Harness />
      </MemoryRouter>,
    );
    await screen.findByText('conflicts: 1, approvals: 1, measures: 1');

    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(conflictsCalls).toBe(2));

    // The new pathname's conflicts request is still in flight: the counts shown before the
    // navigation must still be on screen, not EMPTY_COUNTS.
    expect(screen.getByText('conflicts: 1, approvals: 1, measures: 1')).toBeInTheDocument();

    deferred.resolve({ docs: [], count: 9 });
    await screen.findByText('conflicts: 9, approvals: 1, measures: 1');
  });

  it('keeps two mounted consumers agreeing on the counts through a route change', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    const fetchMock = fetchStub({ conflictsCount: 1, approvalsCount: 1, measuresCount: 1 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/a']}>
        <NavigateButton to="/b" />
        <Harness />
        <Harness />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getAllByText('conflicts: 1, approvals: 1, measures: 1')).toHaveLength(2);
    });

    fetchMock.mockImplementation(
      fetchStub({ conflictsCount: 2, approvalsCount: 2, measuresCount: 2 }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    await waitFor(() => {
      expect(screen.getAllByText('conflicts: 2, approvals: 2, measures: 2')).toHaveLength(2);
    });
  });

  it('clears the counts on sign-out and drops a response that arrives after', async () => {
    const ensureSessionMock = vi.spyOn(auth, 'ensureSession');
    ensureSessionMock.mockResolvedValueOnce(member);
    const deferred = deferredJsonResponse<{ docs: unknown[]; count: number }>();
    let conflictsCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/v1/conflicts')) {
        conflictsCalls += 1;
        return conflictsCalls === 1
          ? Promise.resolve(jsonResponse({ docs: [], count: 1 }))
          : deferred.promise;
      }
      if (url.startsWith('/api/v1/approvals')) {
        return Promise.resolve(jsonResponse({ docs: [], count: 1 }));
      }
      if (url.startsWith('/api/v1/measures')) {
        return Promise.resolve(jsonResponse({ docs: [], count: 1 }));
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/adjudication']}>
        <Harness />
      </MemoryRouter>,
    );
    await screen.findByText('conflicts: 1, approvals: 1, measures: 1');

    // A second conflicts request is in flight when sign-out happens.
    invalidatePendingCounts();
    await waitFor(() => expect(conflictsCalls).toBe(2));

    ensureSessionMock.mockResolvedValueOnce(null);
    auth.clearSession();

    await screen.findByText('conflicts: null, approvals: null, measures: null');

    // The in-flight request from the signed-in engine must not resurrect a stale count.
    deferred.resolve({ docs: [], count: 9 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      screen.getByText('conflicts: null, approvals: null, measures: null'),
    ).toBeInTheDocument();
  });

  it('applies only the newest response when a refetch overtakes an older one', async () => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(member);
    const first = deferredJsonResponse<{ docs: unknown[]; count: number }>();
    const second = deferredJsonResponse<{ docs: unknown[]; count: number }>();
    let conflictsCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/v1/conflicts')) {
        conflictsCalls += 1;
        return conflictsCalls === 1 ? first.promise : second.promise;
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/adjudication']}>
        <Harness />
      </MemoryRouter>,
    );
    await waitFor(() => expect(conflictsCalls).toBe(1));

    invalidatePendingCounts();
    await waitFor(() => expect(conflictsCalls).toBe(2));

    // The overtaking (second) load settles first...
    second.resolve({ docs: [], count: 5 });
    await screen.findByText('conflicts: 5, approvals: 0, measures: 0');

    // ...and the superseded first load settling afterwards must not overwrite it.
    first.resolve({ docs: [], count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText('conflicts: 5, approvals: 0, measures: 0')).toBeInTheDocument();
  });
});
