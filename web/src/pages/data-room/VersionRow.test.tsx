import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentVersion } from '../../api/client';
import VersionRow from './VersionRow';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const version: DocumentVersion = {
  id: 'v-1',
  versionNumber: 1,
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  ingestionStatus: 'completed',
  reducedFidelityReasons: [],
  createdAt: new Date().toISOString(),
};

const chunks = {
  docs: [
    {
      id: 'chunk-1',
      text: 'Net operating income for Q3 was $1.2M.',
      tokenCount: 12,
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Summary', cell: 'B4' },
    },
  ],
  count: 1,
};

function manyChunks(count: number) {
  const docs = Array.from({ length: count }, (_, index) => ({
    id: `chunk-${index}`,
    text: `Chunk text number ${index}.`,
    tokenCount: 700,
    locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Summary', cell: `B${index}` },
  }));
  return { docs, count };
}

// A version row renders as <tr>/<td> — a bare table row outside <table><tbody> is invalid HTML
// and jsdom logs a nesting warning on every test without this wrapper.
function renderRow(v: DocumentVersion = version) {
  render(
    <table>
      <tbody>
        <VersionRow version={v} />
      </tbody>
    </table>,
  );
}

describe('VersionRow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows a download link for the version, with its size formatted for a reader', () => {
    renderRow();

    const downloadLink = screen.getByRole('link', { name: 'Download' });
    expect(downloadLink).toHaveAttribute('href', '/api/v1/documents/versions/v-1/content');
    expect(screen.getByText('100 B')).toBeInTheDocument();
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

  it('expands to a chunks drill-in, tracking its state in aria-expanded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(chunks)));
    renderRow();

    const toggle = screen.getByRole('button', { name: 'View chunks' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    expect(await screen.findByText('Net operating income for Q3 was $1.2M.')).toBeInTheDocument();
    expect(screen.getByText('xlsx-cell · 12 tokens')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide chunks' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide chunks' }));
    expect(screen.queryByText('Net operating income for Q3 was $1.2M.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View chunks' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('caps a version with more chunks than the preview limit, with a "show all" affordance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(manyChunks(45))));
    renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'View chunks' }));

    await screen.findByText('Chunk text number 0.');
    expect(screen.getAllByText(/^Chunk text number \d+\.$/)).toHaveLength(20);
    expect(screen.getByText('Showing 20 of 45 chunks')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 45 chunks' }));

    expect(screen.getAllByText(/^Chunk text number \d+\.$/)).toHaveLength(45);
    expect(screen.getByText('Showing 45 of 45 chunks')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show all 45 chunks' })).not.toBeInTheDocument();
  });

  it('shows no cap affordance when there are fewer chunks than the preview limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(manyChunks(5))));
    renderRow();

    fireEvent.click(screen.getByRole('button', { name: 'View chunks' }));

    await screen.findByText('Chunk text number 0.');
    expect(screen.getAllByText(/^Chunk text number \d+\.$/)).toHaveLength(5);
    expect(screen.queryByText(/Showing \d+ of \d+ chunks/)).not.toBeInTheDocument();
  });
});
