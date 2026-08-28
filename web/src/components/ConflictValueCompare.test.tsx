import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ConflictValue } from '../api/client';
import ConflictValueCompare from './ConflictValueCompare';
import { workbenchHref } from '../lib/citation-link';
import type { ResolvedVersion } from '../lib/document-index';

function value(overrides: Partial<ConflictValue>): ConflictValue {
  return {
    factId: 'fact-1',
    value: 6.1,
    unit: 'percent',
    sourceChunkId: 'chunk-a',
    documentVersionId: 'docver-1',
    locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
    withdrawn: false,
    ...overrides,
  };
}

const documentIndex = new Map<string, ResolvedVersion>([
  ['docver-1', { documentId: 'doc-1', documentTitle: 'Rent Roll Q1', withdrawn: false }],
  ['docver-2', { documentId: 'doc-2', documentTitle: 'Offering Memo', withdrawn: false }],
  ['docver-3', { documentId: 'doc-3', documentTitle: 'Comps Sheet', withdrawn: true }],
]);

function renderCompare(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('ConflictValueCompare', () => {
  it('shows each value with its unit, source passage, and source chunk', () => {
    renderCompare(
      <ConflictValueCompare
        values={[value({})]}
        documentIndex={documentIndex}
        ruleFired="authority"
        explanation="Source 'chunk-a' outranks the other value's source."
        proposedWinnerFactId="fact-1"
      />,
    );

    expect(screen.getByText('6.1 percent')).toBeInTheDocument();
    expect(screen.getByText('Rent Roll Q1 — p.2')).toBeInTheDocument();
  });

  it('labels the rule that fired on the recommended value only', () => {
    renderCompare(
      <ConflictValueCompare
        values={[
          value({ factId: 'fact-1', value: 6.1 }),
          value({ factId: 'fact-2', value: 5.4, sourceChunkId: 'chunk-b' }),
        ]}
        documentIndex={documentIndex}
        proposedWinnerFactId="fact-1"
        ruleFired="authority"
        explanation="Source 'chunk-a' outranks the other value's source."
      />,
    );

    expect(screen.getByText('recommended · authority')).toBeInTheDocument();
    expect(
      screen.getByText("Source 'chunk-a' outranks the other value's source."),
    ).toBeInTheDocument();
  });

  it('shows the policy explanation once, ahead of the list, when no rule fires', () => {
    renderCompare(
      <ConflictValueCompare
        values={[value({})]}
        documentIndex={documentIndex}
        ruleFired="none"
        explanation="No configured rule distinguishes between these sources."
      />,
    );

    expect(
      screen.getByText(
        'Policy has no recommendation for this conflict — No configured rule distinguishes between these sources.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^recommended ·/)).not.toBeInTheDocument();
  });

  it('reads correctly with three or more competing values, each in its own item', () => {
    renderCompare(
      <ConflictValueCompare
        values={[
          value({ factId: 'fact-1', value: 6.1, documentVersionId: 'docver-1' }),
          value({
            factId: 'fact-2',
            value: 5.4,
            sourceChunkId: 'chunk-b',
            documentVersionId: 'docver-2',
          }),
          value({
            factId: 'fact-3',
            value: 7.2,
            sourceChunkId: 'chunk-c',
            documentVersionId: 'docver-3',
            withdrawn: true,
          }),
        ]}
        documentIndex={documentIndex}
        proposedWinnerFactId="fact-1"
        ruleFired="authority"
        explanation="Source 'chunk-a' outranks the other values' sources."
      />,
    );

    expect(screen.getByText('6.1 percent')).toBeInTheDocument();
    expect(screen.getByText('5.4 percent')).toBeInTheDocument();
    expect(screen.getByText('7.2 percent')).toBeInTheDocument();
    expect(screen.getByText('Rent Roll Q1 — p.2')).toBeInTheDocument();
    expect(screen.getByText('Offering Memo — p.2')).toBeInTheDocument();
    expect(screen.getByText('Comps Sheet — p.2')).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Competing values for this conflict' }),
    ).toBeInTheDocument();
  });

  it('labels a withdrawn competing value', () => {
    renderCompare(
      <ConflictValueCompare
        values={[value({ factId: 'fact-3', documentVersionId: 'docver-3', withdrawn: true })]}
        documentIndex={documentIndex}
      />,
    );

    expect(screen.getByText('Source withdrawn')).toBeInTheDocument();
  });

  it('does not label a value that is not withdrawn', () => {
    renderCompare(
      <ConflictValueCompare values={[value({ withdrawn: false })]} documentIndex={documentIndex} />,
    );

    expect(screen.queryByText('Source withdrawn')).not.toBeInTheDocument();
  });

  it('renders a caller-supplied action per value', () => {
    renderCompare(
      <ConflictValueCompare
        values={[
          value({ factId: 'fact-1' }),
          value({ factId: 'fact-2', sourceChunkId: 'chunk-b' }),
        ]}
        documentIndex={documentIndex}
        renderAction={(v) => <button key={v.factId}>Request resolution</button>}
      />,
    );

    expect(screen.getAllByRole('button', { name: 'Request resolution' })).toHaveLength(2);
  });

  it('falls back to Unknown document when a value cites an unresolved version', () => {
    renderCompare(
      <ConflictValueCompare
        values={[value({ documentVersionId: 'docver-missing' })]}
        documentIndex={documentIndex}
      />,
    );

    expect(screen.getByText('Unknown document — p.2')).toBeInTheDocument();
  });

  it('links the trace chip into the workbench at the source chunk when the version resolves', () => {
    renderCompare(<ConflictValueCompare values={[value({})]} documentIndex={documentIndex} />);

    const chip = screen.getByRole('link', { name: 'chunk-a' });
    expect(chip).toHaveAttribute(
      'href',
      workbenchHref({ documentId: 'doc-1', versionId: 'docver-1', chunkId: 'chunk-a' }),
    );
  });

  it('renders the trace chip as plain text when the version does not resolve', () => {
    renderCompare(
      <ConflictValueCompare
        values={[value({ documentVersionId: 'docver-missing' })]}
        documentIndex={documentIndex}
      />,
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('chunk-a')).toBeInTheDocument();
  });
});
