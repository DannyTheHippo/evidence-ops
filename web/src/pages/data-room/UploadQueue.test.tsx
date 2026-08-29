import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import UploadQueue, { type QueueRow } from './UploadQueue';

describe('UploadQueue', () => {
  it('shows a hint instead of a list when nothing has been added yet', () => {
    render(<UploadQueue rows={[]} />);

    expect(screen.getByText('Files you add appear here.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('renders one row per file, each carrying its own state', () => {
    const rows: QueueRow[] = [
      { id: '1', fileName: 'rent-roll.pdf', state: { kind: 'queued' } },
      { id: '2', fileName: 'memo.docx', state: { kind: 'uploading' } },
      { id: '3', fileName: 'valuation.xlsx', state: { kind: 'uploaded' } },
      {
        id: '4',
        fileName: 'rogue.exe',
        state: { kind: 'failed', message: 'Unsupported file type.' },
      },
    ];

    render(<UploadQueue rows={rows} />);

    expect(screen.getByText('rent-roll.pdf')).toBeInTheDocument();
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('memo.docx')).toBeInTheDocument();
    expect(screen.getByText('Uploading…')).toBeInTheDocument();
    expect(screen.getByText('valuation.xlsx')).toBeInTheDocument();
    expect(screen.getByText('Uploaded')).toBeInTheDocument();
    expect(screen.getByText('rogue.exe')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    // The message that failed it is on the row, not folded into a summary elsewhere.
    expect(screen.getByText('Unsupported file type.')).toBeInTheDocument();
  });

  it('badges a failed row with the rejection tone, not the caution one a pending row carries', () => {
    const rows: QueueRow[] = [
      { id: '1', fileName: 'rogue.exe', state: { kind: 'failed', message: 'Nope.' } },
    ];

    render(<UploadQueue rows={rows} />);

    expect(screen.getByText('Failed').className).toContain('badge--reject');
  });
});
