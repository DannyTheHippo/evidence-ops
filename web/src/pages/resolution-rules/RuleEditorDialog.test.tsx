import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RuleEditorDialog from './RuleEditorDialog';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const updatedPolicy = {
  id: 'policy-1',
  metric: 'cap_rate' as const,
  authorityOrder: ['pm-export', 'crm-export', 'spreadsheet', 'memo', 'report'] as const,
  createdAt: '2026-08-01T00:00:00.000Z',
};

describe('RuleEditorDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('seeds the full rankable list, seeded order first, remainder in canonical order', () => {
    render(
      <RuleEditorDialog
        metric="cap_rate"
        authorityOrder={['pm-export']}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('1pm-export'),
      expect.stringContaining('2crm-export'),
      expect.stringContaining('3spreadsheet'),
      expect.stringContaining('4memo'),
      expect.stringContaining('5report'),
    ]);
  });

  it('defaults to the canonical order when no authority order is authored yet', () => {
    render(
      <RuleEditorDialog
        metric="sale_price"
        authorityOrder={undefined}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(screen.getByText('crm-export')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('1crm-export');
  });

  it('disables the up button at the top and the down button at the bottom', () => {
    render(
      <RuleEditorDialog
        metric="cap_rate"
        authorityOrder={['crm-export', 'pm-export', 'spreadsheet', 'memo', 'report']}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Move crm-export up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move report down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move crm-export down' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move report up' })).not.toBeDisabled();
  });

  it('moves a row and announces the result, not merely the click', () => {
    render(
      <RuleEditorDialog
        metric="cap_rate"
        authorityOrder={['crm-export', 'pm-export', 'spreadsheet', 'memo', 'report']}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move pm-export up' }));

    expect(screen.getByRole('status')).toHaveTextContent('pm-export moved to position 1 of 5.');
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('1pm-export');
    expect(screen.getAllByRole('listitem')[1]).toHaveTextContent('2crm-export');
  });

  // The acceptance test this control exists for: a move that disables the button just pressed
  // must not drop focus to <body>, or keyboard reordering dies mid-task.
  it('preserves focus on the sibling button when a move disables the pressed one', () => {
    render(
      <RuleEditorDialog
        metric="cap_rate"
        authorityOrder={['crm-export', 'pm-export', 'spreadsheet', 'memo', 'report']}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    const moveMemoDown = screen.getByRole('button', { name: 'Move memo down' });
    moveMemoDown.focus();
    fireEvent.click(moveMemoDown);

    // memo is now last, so its own down button is disabled — focus must have moved to its
    // still-enabled sibling rather than being lost.
    expect(screen.getByRole('button', { name: 'Move memo down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move memo up' })).toHaveFocus();
  });

  it('saves the full order plus any existing staleness window, and reports success', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(updatedPolicy)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    render(
      <RuleEditorDialog
        metric="cap_rate"
        authorityOrder={['crm-export', 'pm-export', 'spreadsheet', 'memo', 'report']}
        stalenessWindowMs={5000}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move pm-export up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save order' }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(updatedPolicy));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/metric-policies/cap_rate');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      authorityOrder: ['pm-export', 'crm-export', 'spreadsheet', 'memo', 'report'],
      stalenessWindowMs: 5000,
    });
  });

  it('renders a rejected save verbatim and keeps the dialog open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse({ message: 'authorityOrder contains a duplicate rank' }, 400)),
      ),
    );
    const onSaved = vi.fn();

    render(
      <RuleEditorDialog
        metric="cap_rate"
        authorityOrder={['crm-export', 'pm-export', 'spreadsheet', 'memo', 'report']}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save order' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'authorityOrder contains a duplicate rank',
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('calls onClose from the cancel action', () => {
    const onClose = vi.fn();
    render(
      <RuleEditorDialog
        metric="cap_rate"
        authorityOrder={['crm-export', 'pm-export', 'spreadsheet', 'memo', 'report']}
        onClose={onClose}
        onSaved={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
