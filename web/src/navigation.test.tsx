/// <reference types="vite/client" />
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import routesSource from './AuthenticatedRoutes.tsx?raw';
import App from './App';
import { NAV_LABELS } from './components/shell/Sidebar';
import * as auth from './lib/auth';

// Kept in sync with AuthenticatedRoutes.tsx's RequireAdmin-wrapped routes — the invariant test
// below verifies this set is exhaustive over the literal route table, so a route moving in or out
// of RequireAdmin without this set changing fails the routesSource assertion, not silently.
const ADMIN_ONLY = new Set(['/people', '/audit-events', '/canonical-entities']);

const ADMIN_ME = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'admin' as const,
  createdAt: new Date().toISOString(),
};

const MEMBER_ME = {
  id: 'member-1',
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

// Every list/detail endpoint a NAV_LABELS destination fetches on mount reads a `{ docs, count }`
// envelope; the two exceptions are named explicitly rather than folded into the generic branch,
// since answering them with the wrong shape would make a page throw during render instead of
// exercising the path this test is meant to cover.
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/v1/metrics') return Promise.resolve(jsonResponse([]));
      if (url === '/api/v1/dashboard/summary') {
        return Promise.resolve(
          jsonResponse({
            pendingApprovalCount: 0,
            openConflictCount: 0,
            documentCount: 0,
            sourceCount: 0,
            ingestionFailedCount: 0,
            syncFailedCount: 0,
            needsOcrCount: 0,
            factsFailedCount: 0,
            answerCount: 0,
            hasIngestedDocument: false,
          }),
        );
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    }),
  );
}

describe('navigation invariant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(NAV_LABELS)('resolves $to for an admin without a 404', async ({ to, label }) => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(ADMIN_ME);
    stubFetch();

    render(
      <MemoryRouter initialEntries={[to]}>
        <App />
      </MemoryRouter>,
    );

    // Every routed page opens with PageHeader's <h1>; NotFoundView has no heading at all. Waiting
    // for one is what makes the assertions below meaningful — document.title is derived from
    // NAV_LABELS itself and would already read correctly even while RequireAuth or the lazy
    // AuthenticatedRoutes chunk is still resolving, so asserting on it without first waiting for
    // the real page to mount would pass whether or not the route actually existed.
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('Page not found')).not.toBeInTheDocument();
    expect(document.title).toBe(`${label} · Evidence Ops`);
  });

  it.each(NAV_LABELS)('resolves $to for a member', async ({ to, label }) => {
    vi.spyOn(auth, 'ensureSession').mockResolvedValue(MEMBER_ME);
    stubFetch();

    render(
      <MemoryRouter initialEntries={[to]}>
        <App />
      </MemoryRouter>,
    );

    if (ADMIN_ONLY.has(to)) {
      // RequireAdmin shows the 403 view for a non-admin rather than rendering the page or a 404.
      expect(
        await screen.findByRole('heading', { name: "You don't have access to this page" }),
      ).toBeInTheDocument();
      return;
    }

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('Page not found')).not.toBeInTheDocument();
    expect(document.title).toBe(`${label} · Evidence Ops`);
  });

  it.each(NAV_LABELS)(
    'the sidebar links to $to as "$label" for an admin',
    async ({ to, label }) => {
      vi.spyOn(auth, 'ensureSession').mockResolvedValue(ADMIN_ME);
      stubFetch();

      render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>,
      );

      expect(await screen.findByRole('link', { name: label })).toHaveAttribute('href', to);
    },
  );

  // Property, not a hand-maintained list: parses AuthenticatedRoutes.tsx's own source rather than
  // restating its route table, so a route added or renamed there without a matching NAV_LABELS
  // entry (or vice versa) fails here instead of only surfacing as a live 404. Parametric routes
  // (`:id`) and the wildcard 404 route carry no nav destination and are excluded; `/invitations`
  // is the one route documented as a bare redirect shim with nothing to link to.
  it('every literal AuthenticatedRoutes path matches a NAV_LABELS destination, and vice versa', () => {
    const literalPaths = [...routesSource.matchAll(/path="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((path) => !path.includes(':') && !path.includes('*') && path !== '/invitations');

    // Fails closed: a regex that stopped matching anything (a route table reformatted to single
    // quotes, say) would otherwise let both loops below pass over empty arrays.
    expect(literalPaths.length).toBeGreaterThanOrEqual(10);

    const navPaths = NAV_LABELS.map((item) => item.to);
    for (const literalPath of literalPaths) {
      expect(navPaths).toContain(literalPath);
    }
    for (const navPath of navPaths) {
      expect(literalPaths).toContain(navPath);
    }
  });
});
