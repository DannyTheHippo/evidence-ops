import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConflictsPage from './ConflictsPage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ConflictsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists open conflicts with their fact key and status', async () => {
    const conflicts = {
      docs: [
        {
          id: 'conflict-1',
          factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
          factIds: ['fact-1', 'fact-2'],
          magnitude: 0.0085,
          status: 'open',
          createdAt: new Date().toISOString(),
        },
      ],
      count: 1,
    };

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(conflicts));
    vi.stubGlobal('fetch', fetchMock);

    render(<ConflictsPage />);

    expect(await screen.findByText('Northgate Business Park')).toBeInTheDocument();
    expect(screen.getByText('cap_rate')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
  });
});
