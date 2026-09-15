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

function openMintDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Mint key' }));
  return screen.getByRole('dialog', { name: 'Mint a key' });
}

const DEFAULT_LIST_URL = '/api/v1/api-keys?skip=0&limit=25&sort=createdAt&sortDir=desc';

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
  expiresAt: '2099-01-01T00:00:00.000Z',
};

// What the list endpoint returns for `mintedKey` once minted — the server's list mapping never
// includes a token, so this is the shape a post-mint reload actually resolves to.
const listedMintedKey = {
  id: mintedKey.id,
  name: mintedKey.name,
  tokenPrefix: mintedKey.tokenPrefix,
  createdAt: mintedKey.createdAt,
  expiresAt: mintedKey.expiresAt,
};

// A rotation onto `existingKey`'s row: same id and name, a fresh token and prefix.
const rotatedKey = {
  id: existingKey.id,
  name: existingKey.name,
  token: 'eo_pat_rotatedtoken456',
  tokenPrefix: 'eo_pat_rotate',
  createdAt: existingKey.createdAt,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('ApiKeysPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('names the Account area in the eyebrow, not Admin; the route itself stays signed-in-only', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();

    expect(await screen.findByText('Account')).toBeInTheDocument();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('lists existing keys, showing only the prefix, never a token', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [existingKey], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('CI integration', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('eo_pat_9f8c12…')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    // existingKey carries no expiresAt or lastUsedAt — a key that has never expired or been used
    // reads as an explicit absence, not a blank cell.
    expect(screen.getByText('Never expires')).toBeInTheDocument();
    expect(screen.getByText('Never used')).toBeInTheDocument();

    expect(
      screen.getByRole('region', { name: 'API keys that authenticate an MCP client as you' }),
    ).toHaveAttribute('tabindex', '0');
  });

  it('drops the "Never used" absence text once a key has authenticated a request', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [usedKey], count: 1 }),
    });

    renderPage();

    expect(await screen.findByText('MCP integration', { selector: 'td' })).toBeInTheDocument();
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

    // The expired row offers no Rotate — it would only mint a token that is dead on arrival — but
    // still offers Revoke, plus a hint pointing at the header's "Mint key" action.
    const expiredRow = screen.getByText('Stale integration', { selector: 'td' }).closest('tr');
    expect(expiredRow).not.toBeNull();
    expect(
      within(expiredRow as HTMLElement).queryByRole('button', { name: /^Rotate/ }),
    ).not.toBeInTheDocument();
    expect(
      within(expiredRow as HTMLElement).getByRole('button', { name: /^Revoke/ }),
    ).toBeInTheDocument();
    expect(
      within(expiredRow as HTMLElement).getByText('Expired — mint a new key'),
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
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 30 }));
      }
      if (url === '/api/v1/api-keys?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ message: 'Keys unavailable' }, 500));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('CI integration', { selector: 'td' });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Keys unavailable');
    expect(screen.getByText('CI integration', { selector: 'td' })).toBeInTheDocument();
  });

  it('opens the mint dialog from the header action and closes it on Cancel without minting', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument();
    expect(
      within(dialog).getByText('So you can tell this key apart from your others later.'),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('caps the expiry picker at exactly 365 days out, mirroring the server bound', async () => {
    const now = new Date(2026, 8, 14, 10, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);

    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    const expiresInput = within(dialog).getByLabelText(/Expires/);

    const oneDayMs = 24 * 60 * 60 * 1000;
    const expected = new Date(now.getTime() + 365 * oneDayMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedValue = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}`;

    expect(expiresInput.getAttribute('max')).toBe(expectedValue);
  });

  it('refuses an expiry beyond the 365-day bound before any request is sent', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === DEFAULT_LIST_URL) return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.change(within(dialog).getByLabelText(/Expires/), {
      target: { value: '2099-01-01' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mint' }));

    expect(await screen.findByText('Expiry cannot be more than 365 days out.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/api-keys')).toBe(false);
  });

  it('refuses an expiry that is not in the future before any request is sent', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === DEFAULT_LIST_URL) return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.change(within(dialog).getByLabelText(/Expires/), {
      target: { value: '2020-01-01' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mint' }));

    expect(await screen.findByText('Expiry must be in the future.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/api-keys')).toBe(false);
  });

  it('fills the expiry from a preset', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '90 days' }));

    // Matches the page's own local-calendar math (`new Date(); setDate(getDate() + days)`), never
    // a UTC slice, so this stays correct regardless of the host timezone.
    const expected = new Date();
    expected.setDate(expected.getDate() + 90);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedValue = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}`;

    expect(within(dialog).getByLabelText(/Expires/)).toHaveValue(expectedValue);
  });

  it('fills the expiry from the 365-day preset exactly on the server maximum, matching the hint', async () => {
    const now = new Date(2026, 8, 14, 10, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);

    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '365 days' }));

    const oneDayMs = 24 * 60 * 60 * 1000;
    const expected = new Date(now.getTime() + 365 * oneDayMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedValue = `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}`;

    expect(within(dialog).getByLabelText(/Expires/)).toHaveValue(expectedValue);
    // Every other day expires at 23:59:59 local time; the last eligible day expires at the bound
    // instant itself, which the hint states so the operator sees it rather than assuming midnight.
    const expectedTime = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(
      expected,
    );
    expect(
      within(dialog).getByText(
        `On this last day the key expires at ${expectedTime}, the 365-day limit.`,
      ),
    ).toBeInTheDocument();
  });

  it('renders the expiry presets as sized buttons carrying an existing kit class, not bare buttons', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    const preset = within(dialog).getByRole('button', { name: '30 days' });

    expect(preset.className).toContain('btn--sm');
  });

  it('mints at the 365-day preset without submitting an instant past the server bound', async () => {
    const now = new Date(2026, 8, 14, 10, 0, 0);
    // Fakes `Date` only, leaving `setTimeout` real, so `findByText`'s polling still settles.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);

    let mintBody: string | undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === DEFAULT_LIST_URL) return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      if (url === '/api/v1/api-keys' && init?.method === 'POST') {
        mintBody = init.body as string;
        return Promise.resolve(jsonResponse(mintedKey, 201));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '365 days' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mint' }));

    await waitFor(() => expect(mintBody).toBeDefined());
    const { expiresAt } = JSON.parse(mintBody as string) as { expiresAt: string };
    const oneDayMs = 24 * 60 * 60 * 1000;
    // The server's `@MaxDate` accepts an instant at or before `now + 365 days`; the picked day's
    // own end (23:59:59) falls past that, so the submitted instant is clamped down to it exactly.
    expect(new Date(expiresAt).getTime()).toBe(now.getTime() + 365 * oneDayMs);
  });

  it('refuses an expiry one day past the 365-day bound before any request is sent', async () => {
    const now = new Date(2026, 8, 14, 10, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);

    const fetchMock = vi.fn((url: string) => {
      if (url === DEFAULT_LIST_URL) return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    // One calendar day later than the picker's own max (`now + 365 days`): its start of day already
    // exceeds that bound, so validation refuses it before any request is sent.
    const oneDayMs = 24 * 60 * 60 * 1000;
    const dayAfterBound = new Date(now.getTime() + 366 * oneDayMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dayAfterBoundValue = `${dayAfterBound.getFullYear()}-${pad(dayAfterBound.getMonth() + 1)}-${pad(dayAfterBound.getDate())}`;

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.change(within(dialog).getByLabelText(/Expires/), {
      target: { value: dayAfterBoundValue },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mint' }));

    expect(await screen.findByText('Expiry cannot be more than 365 days out.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/api-keys')).toBe(false);
  });

  it('refuses a five-digit-year expiry rather than silently clamping it to the bound', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === DEFAULT_LIST_URL) return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    // A lexicographic string comparison reads '20207-01-01' as earlier than a four-digit-year
    // bound — '0' sorts below the bound's leading digit at the same index — so only a numeric
    // instant comparison refuses this.
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.change(within(dialog).getByLabelText(/Expires/), {
      target: { value: '20207-01-01' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mint' }));

    expect(await screen.findByText('Expiry cannot be more than 365 days out.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/api-keys')).toBe(false);
  });

  it('shows the plaintext token exactly once at mint, unmistakably marked as unrepeatable, and moves focus onto it', async () => {
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

    const dialog = openMintDialog();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mint' }));

    expect(await screen.findByText('eo_pat_brandnewtoken123')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'This is the only time this token is shown. It cannot be retrieved again — copy it now or mint a new key later.',
      ),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(document.activeElement).toHaveClass('secret-reveal');
    });

    // The reloaded list row for the newly minted key shows only its prefix — the token itself
    // never appears anywhere except the one-time panel above.
    const table = await screen.findByRole('table');
    expect(within(table).getByText('eo_pat_brandn…')).toBeInTheDocument();
    for (const row of within(table).getAllByRole('row')) {
      expect(row).not.toHaveTextContent(mintedKey.token);
    }

    // A blank expiry is omitted from the request body entirely, never sent as an empty string.
    const mintCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/v1/api-keys' && (init as RequestInit)?.method === 'POST',
    );
    expect(JSON.parse((mintCall?.[1] as RequestInit).body as string)).toEqual({
      name: 'Local dev',
    });

    // Dismissing the panel is irreversible: the row survives, the token is gone from the document.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(mintedKey.token)).not.toBeInTheDocument();
    expect(within(table).getByText('eo_pat_brandn…')).toBeInTheDocument();
  });

  it('shows a mint server error inside the dialog and keeps it open', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: 'Key limit reached' }, 409));
      }
      if (url === DEFAULT_LIST_URL) return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mint' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Key limit reached');
    expect(screen.getByRole('dialog', { name: 'Mint a key' })).toBeInTheDocument();
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

    const dialog = openMintDialog();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mint' }));
    await screen.findByText(mintedKey.token);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(mintedKey.token);
    });
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('guards against a double mint between the click and the button reporting busy', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(mintedKey, 201));
      }
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('No API keys yet');

    const dialog = openMintDialog();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local dev' } });
    const button = within(dialog).getByRole('button', { name: 'Mint' });
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

    const dialog = openMintDialog();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mint' }));
    await screen.findByText(mintedKey.token);

    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });

  it('rotating shows the new token once through the same panel, and states the old one has stopped working', async () => {
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
    await screen.findByText('CI integration', { selector: 'td' });

    fireEvent.click(screen.getByRole('button', { name: /^Rotate/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));

    expect(await screen.findByText(rotatedKey.token)).toBeInTheDocument();
    expect(
      screen.getByText(
        'This is the only time the new token is shown, and it cannot be retrieved again. The previous token has already stopped working — copy this one now.',
      ),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(document.activeElement).toHaveClass('secret-reveal');
    });

    // The row's prefix reflects the new token, in place, with no separate reload.
    expect(screen.getByText('eo_pat_rotate…')).toBeInTheDocument();
    expect(screen.queryByText('eo_pat_9f8c12…')).not.toBeInTheDocument();

    // Dismissing the panel is the only way to lose the new token too — it does not come back.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(rotatedKey.token)).not.toBeInTheDocument();
    expect(screen.getByText('eo_pat_rotate…')).toBeInTheDocument();
  });

  it('marks the rotate-dialog confirm button busy and disables Cancel while a rotation is in flight, blocking a second click', async () => {
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
    await screen.findByText('CI integration', { selector: 'td' });

    fireEvent.click(screen.getByRole('button', { name: /^Rotate/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));

    const busyButton = screen.getByRole('button', { name: 'Rotate key…' });
    expect(busyButton).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    const rotateCallsBeforeSecondClick = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/v1/api-keys/key-1/rotate',
    ).length;
    fireEvent.click(busyButton);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/v1/api-keys/key-1/rotate').length,
    ).toBe(rotateCallsBeforeSecondClick);

    resolveRotate(jsonResponse(rotatedKey, 201));
    expect(await screen.findByText(rotatedKey.token)).toBeInTheDocument();
  });

  it('refuses to rotate an expired key and says to mint instead', async () => {
    let listCalls = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === DEFAULT_LIST_URL) {
        listCalls += 1;
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 1 }));
      }
      if (url === '/api/v1/api-keys/key-1/rotate' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: "API key 'key-1' has expired" }, 409));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('CI integration', { selector: 'td' });

    // `existingKey` carries no `expiresAt`, so the client's own clock still renders it active and
    // offers Rotate — this covers the clock-skew case where the server disagrees.
    fireEvent.click(screen.getByRole('button', { name: /^Rotate/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key' }));

    expect(
      await screen.findByText('This key has already expired. Mint a new key instead.'),
    ).toBeInTheDocument();
    // The server's raw message, which carries an id, never reaches the dialog.
    expect(screen.queryByText(/has expired'/)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(listCalls).toBe(2);
    });
  });

  it('returns to the first page when a key is minted from page 2', async () => {
    let firstPageListCalls = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/api-keys' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(mintedKey, 201));
      }
      if (url === '/api/v1/api-keys?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [usedKey], count: 30 }));
      }
      if (url === DEFAULT_LIST_URL) {
        firstPageListCalls += 1;
        return Promise.resolve(jsonResponse({ docs: [listedMintedKey], count: 31 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/api-keys?skip=25']);
    await screen.findByText('MCP integration', { selector: 'td' });

    const dialog = openMintDialog();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Local dev' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mint' }));

    await screen.findByText(mintedKey.token);

    // The mint resets `skip` through `setUrlState`, which commits one render after the token
    // (local state, set synchronously) — both belong in the same wait.
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();
      expect(firstPageListCalls).toBe(1);
    });
  });

  it('opening the revoke dialog names the key being revoked', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [existingKey], count: 1 }),
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /^Revoke/ }));

    expect(
      screen.getByRole('dialog', { name: `Revoke "${existingKey.name}"?` }),
    ).toBeInTheDocument();
  });

  it('confirming a revoke calls the API, closes the dialog, hides both actions and focuses the row', async () => {
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

    // fireEvent.click moves no focus, so the opener is focused first, as a real press would.
    const opener = await screen.findByRole('button', { name: /^Revoke/ });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }));

    await waitFor(() => {
      expect(screen.getByText('revoked')).toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Revoke/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Rotate/ })).not.toBeInTheDocument();
    // The revoke removed the opener, so focus lands on the row rather than on `body`.
    expect(screen.getByRole('cell', { name: existingKey.name }).closest('tr')).toHaveFocus();
    expect(document.body).not.toHaveFocus();
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

    fireEvent.click(await screen.findByRole('button', { name: /^Revoke/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Revoke/ })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('sorts by a column on click, defaulting to descending and toggling on the active column', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (
        url === DEFAULT_LIST_URL ||
        url === '/api/v1/api-keys?skip=0&limit=25&sort=name&sortDir=desc' ||
        url === '/api/v1/api-keys?skip=0&limit=25&sort=name&sortDir=asc'
      ) {
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('CI integration', { selector: 'td' });

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Name' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/api-keys?skip=0&limit=25&sort=name&sortDir=desc',
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Name, sorted descending' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/api-keys?skip=0&limit=25&sort=name&sortDir=asc',
        ),
      ).toBe(true);
    });
  });

  it('paginates with Previous/Next driven by skip, disabled at the ends', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === DEFAULT_LIST_URL) {
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 30 }));
      }
      if (url === '/api/v1/api-keys?skip=25&limit=25&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [usedKey], count: 30 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('CI integration', { selector: 'td' });

    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByText('MCP integration', { selector: 'td' });
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/api-keys?skip=25&limit=25&sort=createdAt&sortDir=desc',
      ),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  it('carries a chosen page size into the request and the URL', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === DEFAULT_LIST_URL) {
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 1 }));
      }
      if (url === '/api/v1/api-keys?skip=0&limit=50&sort=createdAt&sortDir=desc') {
        return Promise.resolve(jsonResponse({ docs: [existingKey], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByText('CI integration', { selector: 'td' });

    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/api-keys?skip=0&limit=50&sort=createdAt&sortDir=desc',
        ),
      ).toBe(true);
    });
    expect(screen.getByRole('status', { name: 'current search' })).toHaveTextContent('limit=50');
  });

  it('keeps the address bar clean at the default sort and page', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [existingKey], count: 1 }),
    });

    renderPage();

    await screen.findByText('CI integration', { selector: 'td' });
    expect(screen.getByRole('status', { name: 'current search' })).toBeEmptyDOMElement();
  });

  it('reproduces a sorted, paged view from a deep link', async () => {
    stubFetch({
      '/api/v1/api-keys?skip=25&limit=25&sort=name&sortDir=asc': () =>
        jsonResponse({ docs: [usedKey], count: 30 }),
    });

    renderPage(['/api-keys?sort=name&sortDir=asc&skip=25']);

    await screen.findByText('MCP integration', { selector: 'td' });
    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
  });

  it('clamps an out-of-range limit and a negative skip to the default page', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage(['/api-keys?limit=7&skip=-1']);

    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
  });

  it('falls back to the default sort and direction for a hand-edited URL', async () => {
    stubFetch({
      [DEFAULT_LIST_URL]: () => jsonResponse({ docs: [], count: 0 }),
    });

    renderPage(['/api-keys?sort=bogus&sortDir=up']);

    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
