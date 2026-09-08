import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerCell } from '../../api/client';
import LedgerCellDetail from './LedgerCellDetail';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const versionLookup = {
  versionId: 'docver-1',
  documentId: 'doc-1',
  documentTitle: 'Rent Roll Q1',
  versionNumber: 1,
  sourceKind: 'pdf',
  withdrawn: false,
};

const fact = {
  id: 'fact-1',
  factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-Q1' },
  value: { amount: 6.1, unit: 'percent', canonicalAmount: 0.061 },
  rawText: '6.1%',
  confidence: 0.92,
  extractionMethod: 'llm',
  measureId: 'measure-1',
  measureVersion: 1,
  measureStatus: 'confirmed',
  citation: {
    factId: 'fact-1',
    documentId: 'doc-1',
    documentVersionId: 'docver-1',
    sha256: 'a'.repeat(64),
    locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
    extractorVersion: 'v1',
    quote: 'The cap rate is 6.1%.',
    withdrawn: false,
  },
  createdAt: new Date().toISOString(),
};

const singleCell: LedgerCell = {
  entity: 'Northgate Business Park',
  measure: 'cap_rate',
  period: '2025-Q1',
  state: 'single',
  value: { amount: 6.1, unit: 'percent', canonicalAmount: 0.061 },
  factIds: ['fact-1'],
};

const conflictedCell: LedgerCell = {
  entity: 'Riverside Plaza',
  measure: 'cap_rate',
  period: '2025-Q2',
  state: 'conflicted',
  factIds: ['fact-2', 'fact-3'],
  conflictId: 'conflict-1',
};

const adjudicatedCell: LedgerCell = {
  entity: 'Sunset Corridor',
  measure: 'noi',
  period: '2025-Q3',
  state: 'adjudicated',
  value: { amount: 500000, unit: 'usd' },
  factIds: ['fact-4', 'fact-5'],
  conflictId: 'conflict-2',
  winnerWithdrawn: true,
  decision: {
    conflictId: 'conflict-2',
    outcome: 'resolved',
    winningFactId: 'fact-4',
    decidedBy: 'reviewer@example.com',
    reason: 'Authoritative source outranked the other value.',
    resolvedAt: new Date().toISOString(),
    ruleFired: 'authority',
    followedProposal: true,
  },
};

const adjudicatedCellNoWithdrawal: LedgerCell = {
  ...adjudicatedCell,
  entity: 'Meridian Yards',
  conflictId: 'conflict-3',
  winnerWithdrawn: undefined,
  decision: { ...adjudicatedCell.decision!, conflictId: 'conflict-3' },
};

function fetchStub(factsDocs: unknown[] = [fact], failFacts = false) {
  return vi.fn((url: string) => {
    if (url.startsWith('/api/v1/ledger/facts')) {
      if (failFacts) {
        return Promise.resolve(jsonResponse({ message: 'Failed to load facts' }, 500));
      }
      return Promise.resolve(jsonResponse({ docs: factsDocs, count: factsDocs.length }));
    }
    if (url.startsWith('/api/v1/documents/versions/lookup')) {
      return Promise.resolve(jsonResponse({ docs: [versionLookup], count: 1 }));
    }
    return Promise.reject(new Error(`Unhandled fetch: ${url}`));
  });
}

function renderDetail(cell: LedgerCell, measureLabel = 'Cap rate') {
  render(
    <MemoryRouter>
      <LedgerCellDetail cell={cell} measureLabel={measureLabel} />
    </MemoryRouter>,
  );
}

describe('LedgerCellDetail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the cell heading, resolved value, and its facts with citation detail and a workbench link', async () => {
    vi.stubGlobal('fetch', fetchStub());

    renderDetail(singleCell);

    expect(screen.getByText('Loading facts…')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Northgate Business Park · Cap rate · 2025-Q1' }),
    ).toBeInTheDocument();
    expect(screen.getByText('6.1 percent')).toBeInTheDocument();

    expect(await screen.findByText('The cap rate is 6.1%.')).toBeInTheDocument();
    expect(screen.getByText('p.2')).toBeInTheDocument();
    expect(screen.getByText('confirmed')).toBeInTheDocument();

    const link = await screen.findByRole('link', { name: 'Rent Roll Q1' });
    expect(link).toHaveAttribute('href', '/documents/doc-1/versions/docver-1');
  });

  it('badges an unconfirmed measure fact differently from a confirmed one', async () => {
    vi.stubGlobal('fetch', fetchStub([{ ...fact, measureStatus: 'proposed' }]));

    renderDetail(singleCell);

    expect(await screen.findByText('proposed')).toBeInTheDocument();
  });

  it('shows an Adjudicate link for a conflicted cell with no decision', async () => {
    vi.stubGlobal('fetch', fetchStub([]));

    renderDetail(conflictedCell);

    const link = await screen.findByRole('link', { name: 'Adjudicate' });
    expect(link).toHaveAttribute('href', '/adjudication?kind=conflicts&selected=conflict-1');
    expect(screen.queryByRole('heading', { name: 'Decision' })).not.toBeInTheDocument();
  });

  it('renders the decision list, a withdrawn-source flag, and an Open in Adjudication link for an adjudicated cell', async () => {
    vi.stubGlobal('fetch', fetchStub([]));

    renderDetail(adjudicatedCell);

    expect(await screen.findByRole('heading', { name: 'Decision' })).toBeInTheDocument();
    expect(screen.getByText('resolved')).toBeInTheDocument();
    expect(screen.getByText('reviewer@example.com')).toBeInTheDocument();
    expect(screen.getByText('Authoritative source outranked the other value.')).toBeInTheDocument();
    expect(screen.getByText('authority')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('Winning source withdrawn')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Open in Adjudication' });
    expect(link).toHaveAttribute('href', '/adjudication?kind=conflicts&selected=conflict-2');
  });

  it('renders an adjudicated decision with no withdrawn-source flag when the winner still stands', async () => {
    vi.stubGlobal('fetch', fetchStub([]));

    renderDetail(adjudicatedCellNoWithdrawal);

    expect(await screen.findByRole('heading', { name: 'Decision' })).toBeInTheDocument();
    expect(screen.queryByText('Winning source withdrawn')).not.toBeInTheDocument();
  });

  it('shows an error when the facts fetch fails', async () => {
    vi.stubGlobal('fetch', fetchStub([], true));

    renderDetail(singleCell);

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load facts');
  });
});
