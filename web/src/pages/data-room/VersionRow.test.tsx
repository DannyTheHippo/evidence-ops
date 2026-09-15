import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
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
function renderRow(
  v: DocumentVersion = version,
  documentId = 'doc-1',
  options: { isCurrent?: boolean; onOpenDetails?: (version: DocumentVersion) => void } = {},
) {
  render(
    <MemoryRouter>
      <table>
        <tbody>
          <VersionRow
            version={v}
            documentId={documentId}
            documentTitle="Q3 Rent Roll"
            isCurrent={options.isCurrent ?? false}
            onOpenDetails={options.onOpenDetails ?? vi.fn()}
          />
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

  it('marks the current version with aria-current and a Current badge', () => {
    renderRow(version, 'doc-1', { isCurrent: true });

    expect(screen.getByRole('row')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Current').className).toContain('badge--info');
  });

  it('carries no aria-current and no Current badge on a non-current version', () => {
    renderRow(version, 'doc-1', { isCurrent: false });

    expect(screen.getByRole('row')).not.toHaveAttribute('aria-current');
    expect(screen.queryByText('Current')).not.toBeInTheDocument();
  });

  it('opens the full sha256 tooltip when keyboard focus reaches the truncated digest', async () => {
    renderRow();

    const digest = screen.getByText(`${'a'.repeat(8)}…${'a'.repeat(4)}`);
    expect(digest).toHaveAttribute('tabindex', '0');

    digest.focus();
    const surface = await screen.findByRole('tooltip');
    expect(surface).toHaveTextContent('a'.repeat(64));
    expect(digest).toHaveAttribute('aria-describedby', surface.id);
  });

  it('opens the version details on the Details control, named for its row', () => {
    const onOpenDetails = vi.fn();
    renderRow(version, 'doc-1', { onOpenDetails });

    fireEvent.click(screen.getByRole('button', { name: 'Version 1 details, Q3 Rent Roll' }));

    expect(onOpenDetails).toHaveBeenCalledWith(version);
  });
});
