import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { DocumentVersion } from '../../api/client';
import VersionRow from './VersionRow';

const version: DocumentVersion = {
  id: 'v-1',
  versionNumber: 1,
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  ingestionStatus: 'completed',
  reducedFidelityReasons: [],
  createdAt: new Date().toISOString(),
};

// A version row renders as <tr>/<td> — a bare table row outside <table><tbody> is invalid HTML
// and jsdom logs a nesting warning on every test without this wrapper. `Link` also needs a router
// context, hence `MemoryRouter`.
function renderRow(v: DocumentVersion = version, documentId = 'doc-1') {
  render(
    <MemoryRouter>
      <table>
        <tbody>
          <VersionRow version={v} documentId={documentId} />
        </tbody>
      </table>
    </MemoryRouter>,
  );
}

describe('VersionRow', () => {
  it('shows a download link for the version, with its size formatted for a reader', () => {
    renderRow();

    const downloadLink = screen.getByRole('link', { name: 'Download' });
    expect(downloadLink).toHaveAttribute('href', '/api/v1/documents/versions/v-1/content');
    expect(screen.getByText('100 B')).toBeInTheDocument();
  });

  it('links into the workbench reader for this document and version', () => {
    renderRow(version, 'doc-9');

    const readerLink = screen.getByRole('link', { name: 'Open in reader' });
    expect(readerLink).toHaveAttribute('href', '/documents/doc-9/versions/v-1');
  });

  it('shows the parser reason on a failed version', () => {
    renderRow({
      ...version,
      ingestionStatus: 'failed',
      ingestionFailureReason: 'DOCX parse failed: unsupported OOXML part',
    });

    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('DOCX parse failed: unsupported OOXML part')).toBeInTheDocument();
  });

  it('names every fidelity reason on a version ingested with known fidelity loss', () => {
    renderRow({
      ...version,
      reducedFidelityReasons: [
        'Document has 3 page(s) with no extractable text; falling back to OCR-only extraction',
        'Header row on sheet "Summary" was ambiguous; column names were inferred',
      ],
    });

    expect(screen.getByText('reduced fidelity').className).toContain('badge--possible');
    expect(
      screen.getByText(
        'Document has 3 page(s) with no extractable text; falling back to OCR-only extraction',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Header row on sheet "Summary" was ambiguous; column names were inferred'),
    ).toBeInTheDocument();
  });

  it('says nothing about fidelity on a version with no known fidelity loss', () => {
    renderRow();

    expect(screen.queryByText('reduced fidelity')).not.toBeInTheDocument();
    expect(screen.queryByText(/fidelity/i)).not.toBeInTheDocument();
  });
});
