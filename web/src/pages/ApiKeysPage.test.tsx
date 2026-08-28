import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApiKeysPage from './ApiKeysPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Dispatches by URL and method, matching AnswersPage.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, (init?: RequestInit) => Response>): void {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

// Exposes the current query string as accessible text, since `MemoryRouter` gives a test no other
// way to read it — proves the URL round-trip without reaching into router internals.
function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current search">{location.search}</output>;
}

function renderPage(initialEntries: string[] = ['/api-keys']) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <ApiKeysPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const DEFAULT_LIST_URL = '/api/v1/api-keys?skip=0&limit=20&sort=createdAt&sortDir=desc';

const existingKey = {
  id: 'key-1',
  name: 'CI integration',
  tokenPrefix: 'eo_pat_9f8c12',
  createdAt: '2026-07-01T00:00:00.000Z',
};

const usedKey = {
  id: 'key-3',
  name: 'MCP integration',
  tokenPrefix: 'eo_pat_ab12cd',
  createdAt: '2026-06-01T00:00:00.000Z',
  lastUsedAt: '2026-08-10T09:30:00.000Z',
};

const expiredKey = {
  id: 'key-4',
  name: 'Stale integration',
  tokenPrefix: 'eo_pat_staleaa',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
};

const revokedKey = {
  id: 'key-5',
  name: 'Retired integration',
  tokenPrefix: 'eo_pat_retire1',
  createdAt: '2026-01-01T00:00:00.000Z',
  revokedAt: '2026-02-01T00:00:00.000Z',
};

const mintedKey = {
  id: 'key-2',
  name: 'Local dev',
  token: 'eo_pat_brandnewtoken123',
  tokenPrefix: 'eo_pat_brandn',
  createdAt: '2026-08-01T00:00:00.000Z',
};

// What the list endpoint returns for `mintedKey` once minted — the server's list mapping never
// includes a token, so this is the shape a post-mint reload actually resolves to.
const listedMintedKey = {
  id: mintedKey.id,
  name: mintedKey.name,
  tokenPrefix: mintedKey.tokenPrefix,
  createdAt: mintedKey.createdAt,
};

// A rotation onto `existingKey`'s row: same id and name, a fresh token and prefix.
const rotatedKey = {
  id: existingKey.id,
  name: existingKey.name,
  token: 'eo_pat_rotatedtoken456',
  tokenPrefix: 'eo_pat_rotate',
  createdAt: existingKey.createdAt,
};

describe('ApiKeysPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists existing keys, showing only the prefix, never a token', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [existingKey], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('CI integration')).toBeInTheDocument();
    expect(screen.getByText('eo_pat_9f8c12…')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    // existingKey carries no expiresAt or lastUsedAt — a key that has never expired or been used
    // reads as an explicit absence, not a blank cell.
    expect(screen.getByText('Never expires')).toBeInTheDocument();
    expect(screen.getByText('Never used')).toBeInTheDocument();
  });

  it('drops the "Never used" absence text once a key has authenticated a request', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [usedKey], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('MCP integration')).toBeInTheDocument();
    expect(screen.queryByText('Never used')).not.toBeInTheDocument();
  });

  it('reads statuses for an expired and a revoked key, hiding actions once revoked', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [expiredKey, revokedKey], count: 2 }),
    });

    renderPage();

    expect(await screen.findByText('expired')).toBeInTheDocument();
    expect(screen.getByText('revoked')).toBeInTheDocument();

    const revokedRow = screen.getByText('Retired integration').closest('tr');
    expect(revokedRow).not.toBeNull();
    expect(within(revokedRow as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
  });

  it('tells the operator what a blank expiry actually does', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('No API keys yet');

    expect(
      screen.getByText(
        'Leave blank and the platform applies its own default expiry. Set a date to choose a different one.',
      ),
    ).toBeInTheDocument();
  });

  it('reads as empty when there are no keys', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        'An API key authenticates the MCP surface as you. Mint one above to connect an MCP client.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error and no rows when the initial load fails', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ message: 'Keys unavailable' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Keys unavailable');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps already-loaded rows on screen when a refresh fails', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === DEFAULT_LIST_URL) {
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 25 }));
      }
      if (url === '/api/v1/api-keys?skip=20&limit=20&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ message: 'Keys unavailable' }, 500));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('CI integration');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Keys unavailable');
    expect(screen.getByText('CI integration')).toBeInTheDocument();
  });

  it('shows the plaintext token exactly once at mint, unmistakably marked as unrepeatable', async () => {
    let listCalls = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(mintedKey, 201));
      }
      if (url === DEFAULT_LIST_URL) {
        listCalls += 1;
        // The initial load finds nothing; mint triggers a reload that returns the server's own
        // listing of the new key, never the optimistic client-built row.
        return Promise.resolve(
          listCalls === 1
            ? jsonResponse({ docs: [], count: 0 })
            : jsonResponse({ docs: [listedMintedKey], count: 1 }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No API keys yet');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mint key' }));

    expect(await screen.findByText('eo_pat_brandnewtoken123')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This is the only time this token is shown. It cannot be retrieved again — copy it now or mint a new key later.',
      ),
    ).toBeInTheDocument();

    // The reloaded list row for the newly minted key shows only its prefix — the token itself
    // never appears anywhere except the one-time panel above.
    const table = await screen.findByRole('table');
    expect(within(table).getByText('eo_pat_brandn…')).toBeInTheDocument();
    for (const row of within(table).getAllByRole('row')) {
      expect(row).not.toHaveTextContent(mintedKey.token);
    }

    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      name: 'Local dev',
    });

    // Dismissing the panel is irreversible: the row survives, the token is gone from the document.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(mintedKey.token)).not.toBeInTheDocument();
    expect(within(table).getByText('eo_pat_brandn…')).toBeInTheDocument();
  });

  it('clears the previous one-time token panel when a second mint fails', async () => {
    let mintAttempts = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys' && init?.method === 'POST') {
        mintAttempts += 1;
        return Promise.resolve(
          mintAttempts === 1
            ? jsonResponse(mintedKey, 201)
            : jsonResponse({ message: 'Key limit reached' }, 409),
        );
      }
      if (url === DEFAULT_LIST_URL) {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No API keys yet');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mint key' }));
    expect(await screen.findByText(mintedKey.token)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Second key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mint key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Key limit reached');
    expect(screen.queryByText(mintedKey.token)).not.toBeInTheDocument();
  });

  it('copies the minted token to the clipboard when available', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(mintedKey, 201));
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderPage();
    await screen.findByText('No API keys yet');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mint key' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(mintedKey.token);
    });
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('guards against a double mint between the click and the button becoming disabled', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(mintedKey, 201));
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No API keys yet');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local dev' } });
    const button = screen.getByRole('button', { name: 'Mint key' });
    fireEvent.click(button);
    fireEvent.click(button);

    await screen.findByText(mintedKey.token);

    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/v1/api-keys' && init?.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('warns before an unload once a freshly minted token is on screen, and stays silent once it is gone', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(mintedKey, 201));
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No API keys yet');

    function dispatchBeforeUnload(): Event {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event;
    }

    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mint key' }));
    await screen.findByText(mintedKey.token);

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it('rotating shows the new token once and states the old one has stopped working', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === DEFAULT_LIST_URL) {
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 1 }));
      }
      if (url === '/api/v1/api-keys/key-1/rotate' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(rotatedKey, 201));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('CI integration');

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));

    expect(await screen.findByText(rotatedKey.token)).toBeInTheDocument();
    expect(
      screen.getByText(
        'This is the only time the new token is shown, and it cannot be retrieved again. The previous token has already stopped working — copy this one now.',
      ),
    ).toBeInTheDocument();

    // The row's prefix reflects the new token, in place, with no separate reload.
    expect(screen.getByText('eo_pat_rotate…')).toBeInTheDocument();
    expect(screen.queryByText('eo_pat_9f8c12…')).not.toBeInTheDocument();

    // Dismissing the panel is the only way to lose the new token too — it does not come back.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(rotatedKey.token)).not.toBeInTheDocument();
    expect(screen.getByText('eo_pat_rotate…')).toBeInTheDocument();
  });

  it('disables both rotate-dialog buttons while a rotation is in flight, blocking a second click', async () => {
    let resolveRotate: (response: Response) => void = () => {};
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === DEFAULT_LIST_URL) {
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 1 }));
      }
      if (url === '/api/v1/api-keys/key-1/rotate' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveRotate = resolve;
        });
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('CI integration');

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));

    expect(screen.getByRole('button', { name: 'Rotate key…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    resolveRotate(jsonResponse(rotatedKey, 201));
    expect(await screen.findByText(rotatedKey.token)).toBeInTheDocument();
  });

  it('opening the revoke dialog names the key being revoked', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [existingKey], count: 1 }),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(
      screen.getByRole('dialog', { name: `Revoke "${existingKey.name}"?` }),
    ).toBeInTheDocument();
  });

  it('confirming a revoke calls the API, closes the dialog, and hides both actions', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === DEFAULT_LIST_URL)
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 1 }));
      if (url === '/api/v1/api-keys/key-1' && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }));

    await waitFor(() => {
      expect(screen.getByText('revoked')).toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate' })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, callInit]) => url === '/api/v1/api-keys/key-1' && callInit?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('cancelling a revoke closes the dialog without revoking', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [existingKey], count: 1 }),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('sorts by a column on click, defaulting to descending and toggling on the active column', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url === DEFAULT_LIST_URL ||
        url === '/api/v1/api-keys?skip=0&limit=20&sort=name&sortDir=desc' ||
        url === '/api/v1/api-keys?skip=0&limit=20&sort=name&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('CI integration');

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Name' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/api-keys?skip=0&limit=20&sort=name&sortDir=desc',
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Name, sorted descending' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/api-keys?skip=0&limit=20&sort=name&sortDir=asc',
        ),
      ).toBe(true);
    });
  });

  it('paginates with Previous/Next driven by skip, disabled at the ends', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === DEFAULT_LIST_URL) {
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 25 }));
      }
      if (url === '/api/v1/api-keys?skip=20&limit=20&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [usedKey], count: 25 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('CI integration');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('MCP integration');
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/api-keys?skip=20&limit=20&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });

  it('keeps the address bar clean at the default sort and page', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [existingKey], count: 1 }),
    });

    renderPage();

    await screen.findByText('CI integration');
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();
  });

  it('reproduces a sorted, paged view from a deep link', async () => {
    stubFetch({
      '/api/v1/api-keys?skip=20&limit=20&sort=name&sortDir=asc': () =>
        jsonResponse({ docs: [usedKey], count: 25 }),
    });

    renderPage(['/api-keys?sort=name&sortDir=asc&skip=20']);

    await screen.findByText('MCP integration');
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });
});
