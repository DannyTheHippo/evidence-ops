import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAnnouncements, subscribeAnnouncements } from '../lib/announce';
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
  value: { amount: 54_500_000, unit: 'usd', canonicalAmount: 0.061 },
  factIds: ['fact-1'],
};

const singleCellNoCanonical = {
  entity: 'Bayview Terrace',
  measure: 'cap_rate',
  period: '2025-Q1',
  state: 'single',
  value: { amount: 54_500_000, unit: 'usd' },
  factIds: ['fact-9'],
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
const LEDGER_URL = '/api/v1/ledger?skip=0&limit=25&sort=entity&sortDir=asc';
const PERIOD_ERROR =
  'Enter a month, quarter, year or fiscal year, for example 2025-03, 2025-Q1, 2025 or FY2025.';

function ledgerUrl(period: string): string {
  return `/api/v1/ledger?${new URLSearchParams({
    skip: '0',
    limit: '25',
    period,
    sort: 'entity',
    sortDir: 'asc',
  }).toString()}`;
}

// Dispatches by URL, matching the other list-page tests' `stubFetch` convention — a route this
// doesn't recognize rejects rather than silently returning nothing.
function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
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
    vi.useRealTimers();
    clearAnnouncements();
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
    expect(within(table).getByText('54,500,000 usd')).toBeInTheDocument();
    expect(within(table).getByText('single')).toBeInTheDocument();
    expect(within(table).getByText('conflicted')).toBeInTheDocument();
    // The conflicted row has no resolved value and an undated period — both render as a dash.
    const conflictedRow = within(table).getByText('Riverside Plaza').closest('tr');
    expect(conflictedRow).not.toBeNull();
    expect(within(conflictedRow as HTMLElement).getAllByText('—')).toHaveLength(2);
  });

  it("shows each cell's fact count", async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell, conflictedCell], count: 2 }),
    });

    renderPage();
    const table = await region();

    const singleRow = within(table).getByText('Northgate Business Park').closest('tr');
    expect(singleRow).not.toBeNull();
    expect(within(singleRow as HTMLElement).getByText('1')).toBeInTheDocument();

    const conflictedRow = within(table).getByText('Riverside Plaza').closest('tr');
    expect(conflictedRow).not.toBeNull();
    expect(within(conflictedRow as HTMLElement).getByText('2')).toBeInTheDocument();
  });

  it('renders no canonical-amount tooltip when the fact carries none', async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCellNoCanonical], count: 1 }),
    });

    renderPage();
    const table = await region();

    const value = within(table).getByText('54,500,000 usd');
    expect(value).not.toHaveAttribute('aria-describedby');
    expect(value.closest('.tooltip-anchor')).toBeNull();
  });

  it("shows the canonical amount tagged with the measure's own canonical unit", async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage();
    const table = await region();
    // The measure label and canonical unit arrive in the same response; waiting on the label
    // keeps the tooltip content stable while its open delay runs.
    await within(table).findByText('Cap Rate');

    fireEvent.pointerOver(within(table).getByText('54,500,000 usd'));

    const surface = await screen.findByRole('tooltip');
    expect(surface).toHaveTextContent('0.061 ratio');
  });

  it('opens the canonical-amount tooltip on keyboard focus, even when the unit arrives during the open delay', async () => {
    let resolveMeasures!: (res: Response) => void;
    const measures = new Promise<Response>((resolve) => {
      resolveMeasures = resolve;
    });
    stubFetch({
      [MEASURES_URL]: () => measures,
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage();
    const table = await region();

    const value = within(table).getByText('54,500,000 usd');
    // A real tab stop, not only programmatically focusable.
    expect(value).toHaveAttribute('tabindex', '0');

    // Only the tooltip's clock is faked: fetch and the response body keep the real event loop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    value.focus();
    expect(value).toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // The measures response lands inside the open delay, changing the tooltip's content from the
    // unitless amount to the amount tagged with its canonical unit.
    resolveMeasures(jsonResponse({ docs: [capRateMeasure], count: 1 }));
    await vi.waitFor(() => expect(within(table).getByText('Cap Rate')).toBeInTheDocument(), {
      interval: 10,
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    const surface = screen.getByRole('tooltip');
    expect(value).toHaveAttribute('aria-describedby', surface.id);
    expect(surface).toHaveTextContent('0.061 ratio');
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

  it('keeps an applied measure filter selectable even when the vocabulary omits it', async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      '/api/v1/ledger?skip=0&limit=25&measure=noi&sort=entity&sortDir=asc': () =>
        jsonResponse({ docs: [conflictedCell], count: 1 }),
    });

    renderPage(['/?measure=noi']);
    await region();

    expect(
      within(screen.getByLabelText('Measure')).getByRole('option', { name: 'noi' }),
    ).toBeInTheDocument();
  });

  it('applies a text filter on Enter and a select filter at once, resetting paging', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell, conflictedCell], count: 2 }),
      '/api/v1/ledger?skip=0&limit=25&entity=Northgate&state=conflicted&sort=entity&sortDir=asc':
        () => jsonResponse({ docs: [conflictedCell], count: 1 }),
    });

    renderPage();
    await region();

    const entity = screen.getByLabelText('Entity');
    fireEvent.change(entity, { target: { value: 'Northgate' } });
    fireEvent.keyDown(entity, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'conflicted' } });

    await within(await region()).findByText('Riverside Plaza');
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          url ===
          '/api/v1/ledger?skip=0&limit=25&entity=Northgate&state=conflicted&sort=entity&sortDir=asc',
      ),
    ).toBe(true);
  });

  it('applies the entity filter 300 ms after typing stops', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell, conflictedCell], count: 2 }),
      '/api/v1/ledger?skip=0&limit=25&entity=North&sort=entity&sortDir=asc': () =>
        jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage();
    await region();

    // Only the debounce clock is faked: fetch, the response body and findByRole keep running on
    // the real event loop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fireEvent.change(screen.getByLabelText('Entity'), { target: { value: 'North' } });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(fetchMock.mock.calls.some(([url]) => url.includes('entity=North'))).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    // `act`'s synchronous form has already flushed the resulting fetch call by the time it
    // returns — no `findBy*` needed, which matters here since `findBy*`'s own polling runs on
    // the now-faked `setTimeout`.
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/ledger?skip=0&limit=25&entity=North&sort=entity&sortDir=asc',
      ),
    ).toBe(true);
  });

  it('applies the period filter 300 ms after typing stops', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
      '/api/v1/ledger?skip=0&limit=25&period=2025-Q2&sort=entity&sortDir=asc': () =>
        jsonResponse({ docs: [conflictedCell], count: 1 }),
    });

    renderPage();
    await region();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '2025-Q2' } });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(fetchMock.mock.calls.some(([url]) => url.includes('period=2025-Q2'))).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === '/api/v1/ledger?skip=0&limit=25&period=2025-Q2&sort=entity&sortDir=asc',
      ),
    ).toBe(true);
  });

  it('refuses an invalid period, applying nothing and leaving focus in place', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage();
    await region();

    const period = screen.getByLabelText('Period');
    period.focus();
    fireEvent.change(period, { target: { value: 'garbage' } });
    fireEvent.keyDown(period, { key: 'Enter' });

    expect(period).toHaveFocus();
    expect(period).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(PERIOD_ERROR)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url.includes('period='))).toBe(false);
  });

  // The API writes a closed set of period keys (src/features/evidence/facts/derive-period.ts):
  // month, quarter, year, fiscal year, the undated sentinel, and an unparseable stated period.
  // It never writes a half year.
  it.each([
    ['2025-01', true],
    ['2025-12', true],
    ['2025-Q1', true],
    ['2025-Q4', true],
    ['2025', true],
    ['FY2025', true],
    ['undated', true],
    ['undated:sold in spring', true],
    ['2025-00', false],
    ['2025-13', false],
    ['2025-Q0', false],
    ['2025-Q5', false],
    ['2025-H1', false],
    ['25-Q1', false],
    ['FY25', false],
    ['undated:', false],
    ['Q1-2025', false],
    ['garbage', false],
  ] as const)('period "%s" is accepted=%s', async (period, accepted) => {
    const url = ledgerUrl(period);
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
      [url]: () => jsonResponse({ docs: [conflictedCell], count: 1 }),
    });

    renderPage();
    await region();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const input = screen.getByLabelText('Period');
    fireEvent.change(input, { target: { value: period } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    if (accepted) {
      expect(fetchMock.mock.calls.some(([calledUrl]) => calledUrl === url)).toBe(true);
    } else {
      expect(fetchMock.mock.calls.some(([calledUrl]) => calledUrl.includes('period='))).toBe(false);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText(PERIOD_ERROR)).toBeInTheDocument();
    }
  });

  it('applies a State change at once, with no debounce and no Apply step', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
      '/api/v1/ledger?skip=0&limit=25&state=conflicted&sort=entity&sortDir=asc': () =>
        jsonResponse({ docs: [conflictedCell], count: 1 }),
    });

    renderPage();
    await region();

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'conflicted' } });

    await within(await region()).findByText('Riverside Plaza');
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          url === '/api/v1/ledger?skip=0&limit=25&state=conflicted&sort=entity&sortDir=asc',
      ),
    ).toBe(true);
  });

  it('clamps a negative skip to zero', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [], count: 0 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage(['/?skip=-1']);
    await region();

    expect(fetchMock.mock.calls.some(([url]) => url === LEDGER_URL)).toBe(true);
  });

  it('announces the cell count once a changed filter settles, staying silent on first load', async () => {
    const listener = vi.fn();
    subscribeAnnouncements(listener);

    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
      '/api/v1/ledger?skip=0&limit=25&state=conflicted&sort=entity&sortDir=asc': () =>
        jsonResponse({ docs: [conflictedCell], count: 1 }),
    });

    renderPage();
    await region();
    expect(listener).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'conflicted' } });

    await within(await region()).findByText('Riverside Plaza');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('1 cell');
  });

  it('names the filter form and describes the period format without a visible hint', async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage();
    await region();

    const form = screen.getByRole('form', { name: 'Ledger filters' });
    const period = screen.getByLabelText('Period');
    expect(period).toHaveAttribute('placeholder', '2025-Q1');
    expect(period).toHaveAccessibleDescription(
      'Format: a month, quarter, year or fiscal year, for example 2025-03, 2025-Q1, 2025 or FY2025.',
    );
    // The description is announced but never rendered as hint text, which is what kept this
    // field taller than its neighbours in the toolbar row.
    expect(form.querySelector('.field-hint')).toBeNull();

    const state = screen.getByLabelText('State');
    expect(within(state).getByRole('option', { name: 'All states' })).toBeInTheDocument();
    expect(within(state).getByRole('option', { name: 'Conflicted' })).toBeInTheDocument();
  });

  it('clears the selected cell when filters are applied and when they are cleared', async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
      // The filtered page still carries the selected cell, so only the reset can close the
      // drawer — a list that dropped the row would close it either way.
      '/api/v1/ledger?skip=0&limit=25&entity=Northgate&sort=entity&sortDir=asc': () =>
        jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage();
    await region();

    fireEvent.click(
      within(await region()).getByRole('button', {
        name: 'View facts for Northgate Business Park · Cap Rate',
      }),
    );
    await screen.findByRole('dialog', { name: 'Northgate Business Park · Cap Rate · 2025-Q1' });

    const entity = screen.getByLabelText('Entity');
    fireEvent.change(entity, { target: { value: 'Northgate' } });
    fireEvent.keyDown(entity, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(
      within(await region()).getByRole('button', {
        name: 'View facts for Northgate Business Park · Cap Rate',
      }),
    );
    await screen.findByRole('dialog', { name: 'Northgate Business Park · Cap Rate · 2025-Q1' });

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('clears both text drafts, their timers and the period error on Clear filters, even for an already-empty entity filter', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
      '/api/v1/ledger?skip=0&limit=25&state=conflicted&sort=entity&sortDir=asc': () =>
        jsonResponse({ docs: [conflictedCell], count: 1 }),
    });

    renderPage();
    await region();

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'conflicted' } });
    await within(await region()).findByText('Riverside Plaza');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    // Neither draft has applied yet — the entity filter is still the default, and the period
    // draft is invalid, so its error has not been set either.
    fireEvent.change(screen.getByLabelText('Entity'), { target: { value: 'dil' } });
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '2025-H1' } });

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(screen.getByLabelText('Entity')).toHaveValue('');
    expect(screen.getByLabelText('Period')).toHaveValue('');
    expect(screen.queryByText(PERIOD_ERROR)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(fetchMock.mock.calls.some(([url]) => url.includes('entity=dil'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => url.includes('period='))).toBe(false);
  });

  it('selects a cell on "View facts", marks its row selected, and mounts the cell detail', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage();
    const table = await region();

    fireEvent.click(
      within(table).getByRole('button', {
        name: 'View facts for Northgate Business Park · Cap Rate',
      }),
    );

    const row = within(table).getByText('Northgate Business Park').closest('tr');
    expect(row).toHaveClass('row--selected');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(
      await screen.findByRole('dialog', { name: 'Northgate Business Park · Cap Rate · 2025-Q1' }),
    ).toBeInTheDocument();
    // The drawer titles the cell; the detail body carries no heading of its own.
    expect(
      screen.getAllByRole('heading', { name: 'Northgate Business Park · Cap Rate · 2025-Q1' }),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.startsWith(
          '/api/v1/ledger/facts?entity=Northgate+Business+Park&measure=cap_rate&period=2025-Q1',
        ),
      ),
    ).toBe(true);
  });

  it('drills into an undated cell, sending the undated sentinel as the period', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [conflictedCell], count: 1 }),
    });

    renderPage();
    const table = await region();

    fireEvent.click(
      within(table).getByRole('button', { name: 'View facts for Riverside Plaza · noi' }),
    );

    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          url ===
          '/api/v1/ledger/facts?entity=Riverside+Plaza&measure=noi&period=undated&limit=100',
      ),
    ).toBe(true);
  });

  it("closes the facts drawer and returns focus to the row's View facts button", async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage();
    const table = await region();

    const viewFacts = within(table).getByRole('button', {
      name: 'View facts for Northgate Business Park · Cap Rate',
    });
    viewFacts.focus();
    fireEvent.click(viewFacts);

    await screen.findByRole('dialog', { name: 'Northgate Business Park · Cap Rate · 2025-Q1' });
    // Focus sits inside the sheet before the close, so only the restore can put it back on the
    // control that opened the drawer.
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.click(close);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(viewFacts).toHaveFocus();
  });

  it('shows the pager total and keeps Next enabled when the cell list is truncated', async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [], count: 0 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 60 }),
    });

    renderPage();
    await region();

    expect(screen.getByText('1–25 of 60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'false');
  });

  it('sorts by a column header, requesting the server-side sort', async () => {
    const fetchMock = stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
      '/api/v1/ledger?skip=0&limit=25&sort=entity&sortDir=desc': () =>
        jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage();
    await region();

    // Entity is already the active, ascending-by-default column — a click toggles direction.
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Entity, sorted ascending' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === '/api/v1/ledger?skip=0&limit=25&sort=entity&sortDir=desc',
        ),
      ).toBe(true);
    });
  });

  it('falls back to the default sort and direction for a hand-edited URL', async () => {
    stubFetch({
      [MEASURES_URL]: () => jsonResponse({ docs: [capRateMeasure], count: 1 }),
      [LEDGER_URL]: () => jsonResponse({ docs: [singleCell], count: 1 }),
    });

    renderPage(['/?sort=bogus&sortDir=up']);
    await region();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sort by Entity, sorted ascending' }),
    ).toBeInTheDocument();
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
