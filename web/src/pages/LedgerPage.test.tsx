import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LedgerPage from './LedgerPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const capRateMeasure = {
  id: 'measure-1',
  slug: 'cap_rate',
  label: 'Cap Rate',
  aliases: [],
  valueType: 'percentage',
  canonicalUnit: 'ratio',
  units: [],
  toleranceKind: 'absolute',
  tolerance: 0.0025,
  status: 'confirmed',
  origin: 'seed',
  proposedFrom: [],
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const singleCell = {
  entity: 'Northgate Business Park',
  measure: 'cap_rate',
  period: '2025-Q1',
  state: 'single',
  value: { amount: 6.1, unit: 'percent', canonicalAmount: 0.061 },
  factIds: ['fact-1'],
};

const conflictedCell = {
  entity: 'Riverside Plaza',
  measure: 'noi',
  period: 'undated',
  state: 'conflicted',
  factIds: ['fact-2', 'fact-3'],
  conflictId: 'conflict-1',
};

const MEASURES_URL = '/api/v1/measures?status=confirmed&limit=100';
const LEDGER_URL = '/api/v1/ledger?skip=0&limit=25';

// Dispatches by URL, matching the other list-page tests' `stubFetch` convention — a route this
// doesn't recognize rejects rather than silently returning nothing.
function stubFetch(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn((url: string) => {
    const handler = routes[url];
    if (handler) return Promise.resolve(handler());
    if (url.startsWith('/api/v1/ledger/facts')) {
      return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
    }
    return Promise.reject(new Error(`Unhandled fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage(initialEntries = ['/']) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/" element={<LedgerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function region() {
  return screen.findByRole('region', { name: 'Ledger cells' });
}

describe('LedgerPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists cells with their state badge, resolved value, and an undated period shown as a dash', async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell, conflictedCell], count: 2 }),
    });

    renderPage();

    const table = await region();
    expect(within(table).getByText('Northgate Business Park')).toBeInTheDocument();
    // The measure label comes from the confirmed-measure lookup; a measure this page never
    // resolved (`noi`) falls back to its raw slug.
    expect(within(table).getByText('Cap Rate')).toBeInTheDocument();
    expect(within(table).getByText('noi')).toBeInTheDocument();
    expect(within(table).getByText('2025-Q1')).toBeInTheDocument();
    expect(within(table).getByText('6.1 percent')).toBeInTheDocument();
    expect(within(table).getByText('single')).toBeInTheDocument();
    expect(within(table).getByText('conflicted')).toBeInTheDocument();
    // The conflicted row has no resolved value and an undated period — both render as a dash.
    const conflictedRow = within(table).getByText('Riverside Plaza').closest('tr');
    expect(conflictedRow).not.toBeNull();
    expect(within(conflictedRow as HTMLElement).getAllByText('—')).toHaveLength(2);
  });

  it('fetches the confirmed-measure vocabulary for the filter and Measure column', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage();

    await region();
    expect(fetchMock.mock.calls.some(([url]) => url === MEASURES_URL)).toBe(true);
    expect(
      within(screen.getByLabelText('Measure')).getByRole('option', { name: 'Cap Rate' }),
    ).toBeInTheDocument();
  });

  it('applies the filters on submit and resets paging', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell, conflictedCell], count: 2 }),
      '/api/v1/ledger?skip=0&limit=25&entity=Northgate&state=conflicted': () =>
        jsonResponse({ docs: [conflictedCell], count: 1 }),
    });

    renderPage();
    await region();

    fireEvent.change(screen.getByLabelText('Entity'), { target: { value: 'Northgate' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'conflicted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    await within(await region()).findByText('Riverside Plaza');
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/ledger?skip=0&limit=25&entity=Northgate&state=conflicted',
      ),
    ).toBe(true);
  });

  it('selects a cell on "View facts", marks its row selected, and mounts the cell detail', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage();
    const table = await region();

    fireEvent.click(within(table).getByRole('button', { name: 'View facts' }));

    const row = within(table).getByText('Northgate Business Park').closest('tr');
    expect(row).toHaveClass('row--selected');
    expect(
      await screen.findByRole('heading', { name: 'Northgate Business Park · Cap Rate · 2025-Q1' }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.startsWith(
          '/api/v1/ledger/facts?entity=Northgate+Business+Park&measure=cap_rate&period=2025-Q1',
        ),
      ),
    ).toBe(true);
  });

  it('shows the pager total and keeps Next enabled when the cell list is truncated', async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [], count: 0 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 60 }),
    });

    renderPage();
    await region();

    expect(screen.getByText('1–25 of 60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('shows a page-level error when the ledger fetch fails', async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [], count: 0 }),
      [LEDGER_URL]: () => jsonResponse({ message: 'Ledger is unavailable.' }, 500),
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Ledger is unavailable.');
  });

  it('still renders the ledger list when the measures fetch fails', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === MEASURES_URL) return Promise.reject(new Error('measures unavailable'));
      if (url === LEDGER_URL) {
        return Promise.resolve(jsonResponse({ docs: [singleCell], count: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    const table = await region();
    // The measure label falls back to the raw slug once the confirmed-measure lookup fails.
    expect(within(table).getByText('cap_rate')).toBeInTheDocument();
  });
});
