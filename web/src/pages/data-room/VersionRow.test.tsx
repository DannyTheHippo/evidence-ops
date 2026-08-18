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

  it('shows a download link for the version', () => {
    renderRow();

    const downloadLink = screen.getByRole('link', { name: 'Download' });
    expect(downloadLink).toHaveAttribute('href', '/api/v1/documents/versions/v-1/content');
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
});
