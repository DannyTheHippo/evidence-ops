import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApiKeysPage from './ApiKeysPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const existingKey = {
  id: 'key-1',
  name: 'CI integration',
  tokenPrefix: 'eo_pat_9f8c12',
  createdAt: '2026-07-01T00:00:00.000Z',
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

const usedKey = {
  id: 'key-3',
  name: 'MCP integration',
  tokenPrefix: 'eo_pat_ab12cd',
  createdAt: '2026-06-01T00:00:00.000Z',
  lastUsedAt: '2026-08-10T09:30:00.000Z',
};

// Dispatches by URL and method, matching ApprovalsPage.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, (init?: RequestInit) => Response>): void {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('ApiKeysPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists existing keys, showing only the prefix, never a token', async () => {
    stubFetch({
      '/api/v1/api-keys?skip=0&limit=20': () => jsonResponse({ docs: [existingKey], count: 1 }),
    });

    render(<ApiKeysPage />);

    expect(await screen.findByText('CI integration')).toBeInTheDocument();
    expect(screen.getByText('eo_pat_9f8c12…')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    // existingKey carries no lastUsedAt — a never-used key reads as an explicit absence, not a
    // blank cell or a zero that would assert a measurement that never happened.
    expect(screen.getByText('Never used')).toBeInTheDocument();
  });

  it('renders lastUsedAt for a key that has authenticated a request', async () => {
    stubFetch({
      '/api/v1/api-keys?skip=0&limit=20': () => jsonResponse({ docs: [usedKey], count: 1 }),
    });

    render(<ApiKeysPage />);

    expect(await screen.findByText('MCP integration')).toBeInTheDocument();
    expect(screen.getByText(new Date(usedKey.lastUsedAt).toLocaleString())).toBeInTheDocument();
    expect(screen.queryByText('Never used')).not.toBeInTheDocument();
  });

  it('tells the operator what a blank expiry actually does', async () => {
    stubFetch({
      '/api/v1/api-keys?skip=0&limit=20': () => jsonResponse({ docs: [], count: 0 }),
    });

    render(<ApiKeysPage />);
    await screen.findByText('No API keys yet');

    expect(
      screen.getByText(
        'Leave blank and the platform applies its own default expiry. Set a date to choose a different one.',
      ),
    ).toBeInTheDocument();
  });

  it('reads as empty when there are no keys', async () => {
    stubFetch({
      '/api/v1/api-keys?skip=0&limit=20': () => jsonResponse({ docs: [], count: 0 }),
    });

    render(<ApiKeysPage />);

    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        'An API key authenticates the MCP surface as you. Mint one above to connect an MCP client.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error when the key list fails to load', async () => {
    stubFetch({
      '/api/v1/api-keys?skip=0&limit=20': () => jsonResponse({ message: 'Keys unavailable' }, 500),
    });

    render(<ApiKeysPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Keys unavailable');
  });

  it('shows the plaintext token exactly once at mint, unmistakably marked as unrepeatable', async () => {
    let listCalls = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(mintedKey, 201));
      }
      if (url === '/api/v1/api-keys?skip=0&limit=20') {
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

    render(<ApiKeysPage />);

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
    expect(await screen.findByText('eo_pat_brandn…')).toBeInTheDocument();
    const listRows = screen.getAllByRole('row');
    for (const row of listRows) {
      expect(row).not.toHaveTextContent(mintedKey.token);
    }

    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      name: 'Local dev',
    });

    // Dismissing the panel is irreversible: the row survives, the token is gone from the document.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(mintedKey.token)).not.toBeInTheDocument();
    expect(screen.getByText('eo_pat_brandn…')).toBeInTheDocument();
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
      if (url === '/api/v1/api-keys?skip=0&limit=20') {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApiKeysPage />);
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

    render(<ApiKeysPage />);
    await screen.findByText('No API keys yet');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mint key' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(mintedKey.token);
    });
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('opening the revoke dialog names the key being revoked', async () => {
    stubFetch({
      '/api/v1/api-keys?skip=0&limit=20': () => jsonResponse({ docs: [existingKey], count: 1 }),
    });

    render(<ApiKeysPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(
      screen.getByRole('dialog', { name: `Revoke "${existingKey.name}"?` }),
    ).toBeInTheDocument();
  });

  it('confirming a revoke calls the API and closes the dialog', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys?skip=0&limit=20')
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 1 }));
      if (url === '/api/v1/api-keys/key-1' && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApiKeysPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }));

    await waitFor(() => {
      expect(screen.getByText('revoked')).toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, callInit]) => url === '/api/v1/api-keys/key-1' && callInit?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('cancelling a revoke closes the dialog without revoking', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys?skip=0&limit=20')
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 1 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}, method: ${init?.method}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApiKeysPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, callInit]) => callInit?.method === 'DELETE')).toBe(false);
  });

  it('paginates with Previous/Next driven by skip, disabled at the ends', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/api-keys?skip=0&limit=20') {
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 25 }));
      }
      if (url === '/api/v1/api-keys?skip=20&limit=20') {
        return Promise.resolve(jsonResponse({ docs: [usedKey], count: 25 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApiKeysPage />);
    await screen.findByText('CI integration');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('MCP integration');
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/api-keys?skip=20&limit=20')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });

  it('mints from page 2 and returns to page 1, where the new key sorts', async () => {
    let page1Calls = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(mintedKey, 201));
      }
      if (url === '/api/v1/api-keys?skip=0&limit=20') {
        page1Calls += 1;
        // The first page-1 load is the initial render; the second is the reload mint triggers by
        // resetting `skip` to 0 — it must not be left showing the stale page-1 snapshot.
        return Promise.resolve(
          page1Calls === 1
            ? jsonResponse({ docs: [existingKey], count: 21 })
            : jsonResponse({ docs: [listedMintedKey, existingKey], count: 22 }),
        );
      }
      if (url === '/api/v1/api-keys?skip=20&limit=20') {
        return Promise.resolve(jsonResponse({ docs: [usedKey], count: 21 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApiKeysPage />);
    await screen.findByText('CI integration');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('MCP integration');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mint key' }));

    expect(await screen.findByText('eo_pat_brandnewtoken123')).toBeInTheDocument();
    // Minting from page 2 must not strand the new key off-screen: the view returns to page 1,
    // where it actually sorts, and page 2's row is gone from view.
    expect(await screen.findByText('Local dev')).toBeInTheDocument();
    expect(screen.queryByText('MCP integration')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/v1/api-keys?skip=0&limit=20').length,
    ).toBe(2);
  });
});
