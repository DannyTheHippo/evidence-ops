import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAdmin } from '../App';
import { clearSession } from '../lib/auth';
import ResolutionRulesPage from './ResolutionRulesPage';

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

const capRatePolicy = {
  id: 'policy-1',
  metric: 'cap_rate',
  authorityOrder: ['pm-export', 'spreadsheet'],
  stalenessWindowMs: 5000,
  createdAt: '2026-07-01T00:00:00.000Z',
};

// Dispatches by URL, matching InvitationsPage.test.tsx's stubFetch shape.
function stubFetch(routes: Record<string, (init?: RequestInit) => Response>): void {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('ResolutionRulesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('lists all eight metrics, showing an authored order or "No order configured"', async () => {
    stubFetch({
      '/api/v1/metric-policies': () => jsonResponse({ docs: [capRatePolicy], count: 1 }),
      '/api/v1/conflicts/resolution-backtest': () =>
        jsonResponse({
          results: [],
          agreed: 0,
          disagreed: 0,
          silent: 0,
          unscorable: 0,
          agreementRate: null,
        }),
    });

    render(<ResolutionRulesPage />);

    expect(await screen.findByText('pm-export › spreadsheet')).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    expect(rows).toHaveLength(8);
    expect(screen.getAllByText('No order configured')).toHaveLength(7);
  });

  it('shows the hindsight aggregate and "No scorable conflicts yet" for a null agreement rate', async () => {
    stubFetch({
      '/api/v1/metric-policies': () => jsonResponse({ docs: [], count: 0 }),
      '/api/v1/conflicts/resolution-backtest': () =>
        jsonResponse({
          results: [
            {
              conflictId: 'conflict-1',
              factKey: { entity: 'Northgate', metric: 'cap_rate', period: '2025-03' },
              verdict: 'unscorable',
              recordedOutcome: 'rejected',
              unscorableReason: "Outcome 'rejected' recorded no winning fact to score against.",
            },
          ],
          agreed: 0,
          disagreed: 0,
          silent: 0,
          unscorable: 1,
          agreementRate: null,
        }),
    });

    render(<ResolutionRulesPage />);

    expect(await screen.findByText('Northgate')).toBeInTheDocument();
    expect(screen.getByText('unscorable')).toBeInTheDocument();
    expect(screen.getByText(/No scorable conflicts yet/)).toBeInTheDocument();
    expect(
      screen.getByText("Outcome 'rejected' recorded no winning fact to score against."),
    ).toBeInTheDocument();
  });

  it('never renders 0% for a null agreement rate', async () => {
    stubFetch({
      '/api/v1/metric-policies': () => jsonResponse({ docs: [], count: 0 }),
      '/api/v1/conflicts/resolution-backtest': () =>
        jsonResponse({
          results: [
            {
              conflictId: 'conflict-1',
              factKey: { entity: 'Northgate', metric: 'cap_rate', period: '2025-03' },
              verdict: 'unscorable',
              recordedOutcome: 'rejected',
              unscorableReason: 'no winner recorded',
            },
          ],
          agreed: 0,
          disagreed: 0,
          silent: 0,
          unscorable: 1,
          agreementRate: null,
        }),
    });

    render(<ResolutionRulesPage />);

    await screen.findByText('Northgate');
    expect(screen.queryByText(/0% agreement/)).not.toBeInTheDocument();
  });

  it('renders an empty state when no conflict has ever been resolved', async () => {
    stubFetch({
      '/api/v1/metric-policies': () => jsonResponse({ docs: [], count: 0 }),
      '/api/v1/conflicts/resolution-backtest': () =>
        jsonResponse({
          results: [],
          agreed: 0,
          disagreed: 0,
          silent: 0,
          unscorable: 0,
          agreementRate: null,
        }),
    });

    render(<ResolutionRulesPage />);

    expect(await screen.findByText('Nothing to backtest yet')).toBeInTheDocument();
  });

  it('opens the rule editor for a metric with no authored row and saves a fresh order', async () => {
    const updated = {
      id: 'policy-2',
      metric: 'sale_price',
      authorityOrder: ['crm-export', 'pm-export', 'spreadsheet', 'memo', 'report'],
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/metric-policies') {
        return Promise.resolve(jsonResponse({ docs: [], count: 0 }));
      }
      if (url === '/api/v1/conflicts/resolution-backtest') {
        return Promise.resolve(
          jsonResponse({
            results: [],
            agreed: 0,
            disagreed: 0,
            silent: 0,
            unscorable: 0,
            agreementRate: null,
          }),
        );
      }
      if (url === '/api/v1/metric-policies/sale_price' && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse(updated));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ResolutionRulesPage />);
    await screen.findByText('sale_price');

    const saleRow = screen.getByText('sale_price').closest('tr')!;
    fireEvent.click(within(saleRow).getByRole('button', { name: 'Edit' }));

    expect(
      screen.getByRole('dialog', { name: 'Authority order — sale_price' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save order' }));

    expect(
      await screen.findByText('crm-export › pm-export › spreadsheet › memo › report'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a load error verbatim', async () => {
    stubFetch({
      '/api/v1/metric-policies': () =>
        jsonResponse({ message: 'Resolution rules unavailable' }, 500),
      '/api/v1/conflicts/resolution-backtest': () =>
        jsonResponse({
          results: [],
          agreed: 0,
          disagreed: 0,
          silent: 0,
          unscorable: 0,
          agreementRate: null,
        }),
    });

    render(<ResolutionRulesPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Resolution rules unavailable');
  });

  it('admits an admin to the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(admin),
      '/api/v1/metric-policies': () => jsonResponse({ docs: [], count: 0 }),
      '/api/v1/conflicts/resolution-backtest': () =>
        jsonResponse({
          results: [],
          agreed: 0,
          disagreed: 0,
          silent: 0,
          unscorable: 0,
          agreementRate: null,
        }),
    });

    render(
      <MemoryRouter initialEntries={['/resolution-rules']}>
        <Routes>
          <Route
            path="/resolution-rules"
            element={
              <RequireAdmin>
                <ResolutionRulesPage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Resolution Rules' })).toBeInTheDocument();
  });

  it('bounces a member away from the route wrapped in RequireAdmin', async () => {
    stubFetch({
      '/api/v1/auth/me': () => jsonResponse(member),
    });

    render(
      <MemoryRouter initialEntries={['/resolution-rules']}>
        <Routes>
          <Route path="/" element={<p>home probe</p>} />
          <Route
            path="/resolution-rules"
            element={
              <RequireAdmin>
                <ResolutionRulesPage />
              </RequireAdmin>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('home probe')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Resolution Rules' })).not.toBeInTheDocument();
  });
});
