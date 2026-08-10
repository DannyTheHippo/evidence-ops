import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Citation } from '../api/client';
import CitationPanel from './CitationPanel';

describe('CitationPanel', () => {
  it('renders the quote and a "file — locator" label linking to the document', () => {
    const citation: Citation = {
      docVersionId: 'v1',
      sha256: 'a'.repeat(64),
      chunkId: 'c1',
      locator: { kind: 'xlsx-cell', extractorVersion: '1', sheetName: 'Comps', cell: 'F2' },
      quote: 'The cap rate is approximately 6.10%.',
    };

    render(
      <MemoryRouter>
        <ul>
          <CitationPanel
            citation={citation}
            resolved={{ documentId: 'doc-1', documentTitle: 'comps.xlsx' }}
          />
        </ul>
      </MemoryRouter>,
    );

    expect(screen.getByText('The cap rate is approximately 6.10%.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'comps.xlsx' })).toHaveAttribute(
      'href',
      '/documents/doc-1',
    );
    expect(screen.getByText(/— Comps!F2/)).toBeInTheDocument();
  });

  it('falls back to a plain label with no link when the document has not resolved', () => {
    const citation: Citation = {
      docVersionId: 'v2',
      sha256: 'b'.repeat(64),
      chunkId: 'c2',
      locator: { kind: 'pdf-page', extractorVersion: '1', page: 2 },
      quote: 'Occupancy was 94% as of March 2025.',
    };

    render(
      <MemoryRouter>
        <ul>
          <CitationPanel citation={citation} />
        </ul>
      </MemoryRouter>,
    );

    expect(screen.getByText('Unknown document')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/— p\.2/)).toBeInTheDocument();
  });
});
