import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AnswerOutcome, Citation } from '../api/client';
import type { ResolvedVersion } from '../lib/document-index';
import ProvenanceRail from './ProvenanceRail';

function citation(overrides: Partial<Citation> = {}): Citation {
  return {
    docVersionId: 'v1',
    sha256: 'a1b2c3d4e5f6' + '0'.repeat(48) + '789a',
    // A real EvidenceChunk._id is content-addressed and 64 hex characters wide, so the fixture is
    // too — a short stand-in would not exercise the chip's truncation at all.
    chunkId: 'c6d1cd73' + 'f'.repeat(52) + 'c3db',
    locator: { kind: 'xlsx-cell', extractorVersion: '1', sheetName: 'Comps', cell: 'F2' },
    quote: 'The cap rate is approximately 6.10%.',
    ...overrides,
  };
}

function renderRail(
  outcome: AnswerOutcome,
  documentIndex = new Map<string, ResolvedVersion>(),
  withdrawnDocVersionIds?: ReadonlySet<string>,
) {
  return render(
    <MemoryRouter>
      <ProvenanceRail
        outcome={outcome}
        documentIndex={documentIndex}
        withdrawnDocVersionIds={withdrawnDocVersionIds}
      />
    </MemoryRouter>,
  );
}

describe('ProvenanceRail', () => {
  it('renders a verified node for an answered claim with at least one citation', () => {
    renderRail({
      kind: 'answered',
      claims: [{ statement: 'Occupancy was 94% as of March 2025.', citations: [citation()] }],
    });

    expect(screen.getByText('Occupancy was 94% as of March 2025.')).toBeInTheDocument();
    expect(screen.getByText(/Verified/)).toBeInTheDocument();
    expect(screen.queryByText(/Degraded/)).not.toBeInTheDocument();
    expect(screen.queryByText('Unverified')).not.toBeInTheDocument();
  });

  it('exposes both the rail and its citations as accessible lists', () => {
    renderRail({
      kind: 'answered',
      claims: [{ statement: 'Occupancy was 94% as of March 2025.', citations: [citation()] }],
    });

    expect(screen.getAllByRole('list')).toHaveLength(2);
  });

  it('renders a neutral node for an answered claim with no citations', () => {
    renderRail({
      kind: 'answered',
      claims: [{ statement: 'Unsupported statement.', citations: [] }],
    });

    expect(screen.getByText('Unsupported statement.')).toBeInTheDocument();
    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.queryByText(/Verified/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Degraded/)).not.toBeInTheDocument();
  });

  it('renders a degraded node for insufficient_evidence with no reasonCode', () => {
    renderRail({ kind: 'insufficient_evidence', reason: 'No relevant evidence was retrieved.' });

    expect(screen.getByText('No relevant evidence was retrieved.')).toBeInTheDocument();
    expect(screen.getByText(/Degraded/)).toBeInTheDocument();
    expect(screen.queryByText(/Verified/)).not.toBeInTheDocument();
    expect(screen.queryByText('Unverified')).not.toBeInTheDocument();
  });

  it('renders a neutral node — not degraded — for insufficient_evidence with a reasonCode', () => {
    renderRail({
      kind: 'insufficient_evidence',
      reason: 'The evidence does not address the question.',
      reasonCode: 'evidence_does_not_address_question',
    });

    expect(screen.getByText('The evidence does not address the question.')).toBeInTheDocument();
    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.queryByText(/Degraded/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Verified/)).not.toBeInTheDocument();
  });

  it('renders a neutral node for a conflicting_evidence outcome', () => {
    renderRail({
      kind: 'conflicting_evidence',
      factKey: { entity: 'Building A', metric: 'cap rate', period: '2025-Q1' },
      values: [],
    });

    expect(
      screen.getByText('Conflicting values for Building A — cap rate (2025-Q1)'),
    ).toBeInTheDocument();
    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.queryByText(/Degraded/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Verified/)).not.toBeInTheDocument();
  });

  it('links the trace chip to the document when the index resolves the version', () => {
    const c = citation();
    renderRail(
      { kind: 'answered', claims: [{ statement: 'Statement.', citations: [c] }] },
      new Map([[c.docVersionId, { documentId: 'doc-1', documentTitle: 'comps.xlsx' }]]),
    );

    const chip = screen.getByRole('link', { name: 'a1b2c3d4…789a · c6d1cd73…c3db' });
    expect(chip).toHaveAttribute('href', '/documents/doc-1');
    // Neither identifier is shown in full, and both stay recoverable from the tooltip.
    expect(chip.textContent).not.toContain(c.chunkId);
    expect(chip).toHaveAttribute('title', expect.stringContaining(c.sha256));
    expect(chip).toHaveAttribute('title', expect.stringContaining(c.chunkId));
  });

  it('renders the trace chip as plain text when the index does not resolve the version', () => {
    const c = citation();
    renderRail({ kind: 'answered', claims: [{ statement: 'Statement.', citations: [c] }] });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('a1b2c3d4…789a · c6d1cd73…c3db')).toBeInTheDocument();
  });

  it('marks a citation whose docVersionId is in withdrawnDocVersionIds', () => {
    const c = citation();
    renderRail(
      { kind: 'answered', claims: [{ statement: 'Statement.', citations: [c] }] },
      new Map(),
      new Set([c.docVersionId]),
    );

    expect(screen.getByText('source withdrawn')).toBeInTheDocument();
  });

  it('does not mark a citation whose docVersionId is not in withdrawnDocVersionIds', () => {
    const c = citation();
    renderRail(
      { kind: 'answered', claims: [{ statement: 'Statement.', citations: [c] }] },
      new Map(),
      new Set(['some-other-version']),
    );

    expect(screen.queryByText('source withdrawn')).not.toBeInTheDocument();
  });
});
