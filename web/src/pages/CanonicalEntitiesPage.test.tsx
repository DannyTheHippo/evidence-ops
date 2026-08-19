import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAdmin } from '../AuthenticatedRoutes';
import { clearSession } from '../lib/auth';
import CanonicalEntitiesPage from './CanonicalEntitiesPage';

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

const northgate = {
  id: 'entity-1',
  canonicalName: 'Northgate Plaza',
  aliases: ['Northgate', 'Northgate Shopping Center'],
  createdAt: '2026-07-01T00:00:00.000Z',
};

const southpark = {
  id: 'entity-2',
  canonicalName: 'Southpark Commons',
  aliases: [],
  createdAt: '2026-07-02T00:00:00.000Z',
};

// Dispatches by URL, matching ResolutionRulesPage.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, (init?: RequestInit) => Response>): void {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('CanonicalEntitiesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('lists registered entities with their aliases, and "No aliases" for one with none', async () => {
    stubFetch({
      '/api/v1/canonical-entities?skip=0&limit=25': () =>
        jsonResponse({ docs: [northgate, southpark], count: 2 }),
    });

    render(<CanonicalEntitiesPage />);

    expect(await screen.findByText('Northgate Plaza')).toBeInTheDocument();
    expect(screen.getByText('Northgate, Northgate Shopping Center')).toBeInTheDocument();
    expect(screen.getByText('Southpark Commons')).toBeInTheDocument();
    expect(screen.getByText('No aliases')).toBeInTheDocument();
  });

  it('renders an empty state when nothing is registered', async () => {
    stubFetch({
      '/api/v1/canonical-entities?skip=0&limit=25': () => jsonResponse({ docs: [], count: 0 }),
    });

    render(<CanonicalEntitiesPage />);

    expect(await screen.findByText('No canonical entities registered yet')).toBeInTheDocument();
  });

  it('shows a load error verbatim', async () => {
    stubFetch({
      '/api/v1/canonical-entities?skip=0&limit=25': () =>
        jsonResponse({ message: 'Canonical entity registry unavailable' }, 500),
    });

    render(<CanonicalEntitiesPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Canonical entity registry unavailable',
    );
  });

  it('creates a new entity from the Add entity dialog', async () => {
    const created = {
      id: 'entity-3',
      canonicalName: 'Riverside Tower',
      aliases: ['Riverside'],
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/canonical-entities?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [northgate], count: 1 }));
      }
      if (url === '/api/v1/canonical-entities' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(created, 201));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CanonicalEntitiesPage />);
    await screen.findByText('Northgate Plaza');

    fireEvent.click(screen.getByRole('button', { name: 'Add entity' }));
    const dialog = screen.getByRole('dialog', { name: 'Add canonical entity' });

    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Riverside Tower' },
    });
    fireEvent.change(screen.getByLabelText('Aliases'), { target: { value: 'Riverside' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add entity' }));

    expect(await screen.findByText('Riverside Tower')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('edits an existing entity from its row', async () => {
    const updated = { ...northgate, canonicalName: 'Northgate Plaza II' };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/canonical-entities?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [northgate], count: 1 }));
      }
      if (url === '/api/v1/canonical-entities/entity-1' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse(updated));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CanonicalEntitiesPage />);
    await screen.findByText('Northgate Plaza');

    const row = screen.getByText('Northgate Plaza').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('dialog', { name: 'Edit "Northgate Plaza"' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Northgate Plaza II' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Northgate Plaza II')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders a duplicate-name 409 verbatim and leaves the list unchanged', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/canonical-entities?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [northgate], count: 1 }));
      }
      if (url === '/api/v1/canonical-entities' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            { message: 'A canonical entity named "Northgate Plaza" already exists' },
            409,
          ),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CanonicalEntitiesPage />);
    await screen.findByText('Northgate Plaza');

    fireEvent.click(screen.getByRole('button', { name: 'Add entity' }));
    const dialog = screen.getByRole('dialog', { name: 'Add canonical entity' });
    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Northgate Plaza' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add entity' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A canonical entity named "Northgate Plaza" already exists',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The list stays untouched by the rejected create — still just the one seeded row.
    expect(screen.getAllByRole('row')).toHaveLength(2); // header row + the one seeded entity
  });

  it('confirms before deleting, then removes the row', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/canonical-entities?skip=0&limit=25') {
        return Promise.resolve(jsonResponse({ docs: [northgate, southpark], count: 2 }));
      }
      if (url === '/api/v1/canonical-entities/entity-1' && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CanonicalEntitiesPage />);
    await screen.findByText('Northgate Plaza');

    const row = screen.getByText('Northgate Plaza').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));

    expect(screen.getByRole('dialog', { name: 'Delete "Northgate Plaza"?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete entity' }));

    await vi.waitFor(() => expect(screen.queryByText('Northgate Plaza')).not.toBeInTheDocument());
    expect(screen.getByText('Southpark Commons')).toBeInTheDocument();
  });

  it('admits an admin to the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/canonical-entities?skip=0&limit=25': () => jsonResponse({ docs: [], count: 0 }),
    });

    render(
      <MemoryRouter initialEntries={['/canonical-entities']}>
        <Routes>
          <Route
            path="/canonical-entities"
            element={
              <RequireAdmin>
                <CanonicalEntitiesPage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Canonical Entities' })).toBeInTheDocument();
  });

  it('bounces a member away from the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(member),
    });

    render(
      <MemoryRouter initialEntries={['/canonical-entities']}>
        <Routes>
          <Route path="/" element={<p>home probe</p>} />
          <Route
            path="/canonical-entities"
            element={
              <RequireAdmin>
                <CanonicalEntitiesPage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('home probe')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Canonical Entities' })).not.toBeInTheDocument();
  });
});
