import { act, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import { getBreadcrumbTrail } from '../lib/breadcrumbs';
import VerificationDetailPage from './VerificationDetailPage';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

const verification = {
  id: 'ver-1',
  requestedBy: { kind: 'pat', id: 'pat-1' },
  claims: ['The cap rate is approximately 6.10%.'],
  results: [{ claimIndex: 0, verdict: 'grounded', citations: [] }],
  advisory: 'This check does not certify the source values are correct, only that they are cited.',
  retrievedChunkIds: [],
  atoms: [],
  usage: { promptTokens: 100, completionTokens: 20, costUsd: 0.0025 },
  createdAt: new Date().toISOString(),
  // The bundle no longer auto-fetches without a pinned hash — carried here so the existing
  // auto-load cases keep exercising that path rather than flipping to the Generate button.
  attestationHash: 'hash-1',
};

// A minimal bundle satisfying `AttestationBundleView`'s render — the fields under test here never
// exercise its claim/decision rendering, only that the section mounts.
function attestationResponse(subjectId = verification.id, claims = verification.claims): Response {
  return jsonResponse({
    schemaVersion: 1,
    kind: 'verification',
    subjectId,
    tenantId: 't',
    producedAt: new Date().toISOString(),
    subject: { claims },
    outcome: null,
    claims: [],
    decisions: [],
    measures: [],
    integrity: { algorithm: 'sha256', contentHash: 'abc' },
  });
}

// Dispatches by URL — the verification fetch, `useSession()`'s own `/auth/me` probe, and
// `AttestationBundleView`'s `/attestation` fetch all share this one stubbed `fetch`.
function stubFetch(
  me: typeof admin | typeof member | null,
  verificationResponse: Response,
  verificationId = 'ver-1',
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : '';
      if (url === '/api/v1/auth/me') {
        return me ? Promise.resolve(jsonResponse(me)) : Promise.resolve(jsonResponse({}, 401));
      }
      if (url === `/api/v1/verifications/${verificationId}`) {
        return Promise.resolve(verificationResponse);
      }
      if (url === `/api/v1/verifications/${verificationId}/attestation`) {
        return Promise.resolve(attestationResponse(verificationId));
      }
      if (url.startsWith('/api/v1/documents/versions/lookup')) {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    }),
  );
}

function renderAt(id: string) {
  render(
    <MemoryRouter initialEntries={[`/answers/verifications/${id}`]}>
      <Routes>
        <Route path="/answers/verifications/:id" element={<VerificationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('VerificationDetailPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('renders the title, breadcrumb trail, advisory and requester', async () => {
    stubFetch(member, jsonResponse(verification));

    renderAt('ver-1');

    expect(
      await screen.findByRole('heading', { name: 'The cap rate is approximately 6.10%.' }),
    ).toBeInTheDocument();
    expect(screen.getByText('pat')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This check does not certify the source values are correct, only that they are cited.',
      ),
    ).toBeInTheDocument();
    expect(getBreadcrumbTrail()).toEqual([
      { label: 'Answers', to: '/answers' },
      { label: '1 claim' },
    ]);
  });

  it('mounts the attestation bundle section', async () => {
    stubFetch(member, jsonResponse(verification));

    renderAt('ver-1');

    expect(await screen.findByRole('heading', { name: 'Attestation' })).toBeInTheDocument();
  });

  it("shows an admin the run's cost", async () => {
    stubFetch(admin, jsonResponse(verification));

    renderAt('ver-1');

    expect(await screen.findByText('Run cost')).toBeInTheDocument();
    expect(screen.getByText('$0.0025')).toBeInTheDocument();
  });

  it('never shows the run cost to a member', async () => {
    stubFetch(member, jsonResponse(verification));

    renderAt('ver-1');

    await screen.findByText('pat');
    expect(screen.queryByText('Run cost')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.0025')).not.toBeInTheDocument();
  });

  it('shows "Verification not found" for a 404, not the generic error', async () => {
    stubFetch(member, jsonResponse({ message: "Verification 'ver-1' not found" }, 404));

    renderAt('ver-1');

    expect(await screen.findByText('Verification not found.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all answers' })).toHaveAttribute(
      'href',
      '/answers',
    );
  });

  it('shows the load error for a non-404 failure', async () => {
    stubFetch(member, jsonResponse({ message: 'Verification unavailable' }, 500));

    renderAt('ver-1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Verification unavailable');
  });

  it('renders each claim verdict without the attestation bundle', async () => {
    stubFetch(
      member,
      jsonResponse({
        ...verification,
        claims: ['The cap rate is approximately 6.10%.', 'Occupancy is 92%.'],
        results: [
          { claimIndex: 0, verdict: 'grounded', citations: [] },
          { claimIndex: 1, verdict: 'not_grounded', reasonCode: 'no_citation', citations: [] },
        ],
      }),
    );

    renderAt('ver-1');

    expect(await screen.findByText('grounded')).toBeInTheDocument();
    expect(screen.getByText('not grounded')).toBeInTheDocument();
    expect(screen.getByText('no_citation')).toBeInTheDocument();
    expect(screen.getByText('Occupancy is 92%.')).toBeInTheDocument();
  });

  it('shows a placeholder row for a claim with no recorded result', async () => {
    stubFetch(
      member,
      jsonResponse({
        ...verification,
        claims: ['The cap rate is approximately 6.10%.', 'Occupancy is 92%.'],
        results: [{ claimIndex: 0, verdict: 'grounded', citations: [] }],
      }),
    );

    renderAt('ver-1');

    expect(await screen.findByText('Occupancy is 92%.')).toBeInTheDocument();
    expect(screen.getByText('No result recorded')).toBeInTheDocument();
  });

  it('does not render a stale verification that resolves after navigating away', async () => {
    const first = deferred<Response>();
    const verificationOne = { ...verification, id: 'ver-1', claims: ['First claim'] };
    const verificationTwo = { ...verification, id: 'ver-2', claims: ['Second claim'] };

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : '';
        if (url === '/api/v1/auth/me') return Promise.resolve(jsonResponse(member));
        if (url === '/api/v1/verifications/ver-1') return first.promise;
        if (url === '/api/v1/verifications/ver-1/attestation') {
          return Promise.resolve(attestationResponse('ver-1', verificationOne.claims));
        }
        if (url === '/api/v1/verifications/ver-2') {
          return Promise.resolve(jsonResponse(verificationTwo));
        }
        if (url === '/api/v1/verifications/ver-2/attestation') {
          return Promise.resolve(attestationResponse('ver-2', verificationTwo.claims));
        }
        if (url.startsWith('/api/v1/documents/versions/lookup')) {
          return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
        }
        return Promise.reject(new Error(`Unhandled fetch: ${url}`));
      }),
    );

    render(
      <MemoryRouter initialEntries={['/answers/verifications/ver-1']}>
        <Link to="/answers/verifications/ver-2">Go to second verification</Link>
        <Routes>
          <Route path="/answers/verifications/:id" element={<VerificationDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('status')).toHaveTextContent('Loading verification…');

    fireEvent.click(screen.getByText('Go to second verification'));

    expect(await screen.findByRole('heading', { name: 'Second claim' })).toBeInTheDocument();

    // The first verification's request finally settles after navigation moved to the second —
    // its `id`-keyed effect was already cleaned up, so this must not overwrite what's rendered.
    first.resolve(jsonResponse(verificationOne));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole('heading', { name: 'First claim' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Second claim' })).toBeInTheDocument();
  });
});
