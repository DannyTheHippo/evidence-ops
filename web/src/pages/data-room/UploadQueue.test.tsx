import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import UploadQueue, { type QueueRow } from './UploadQueue';

describe('UploadQueue', () => {
  it('shows a hint instead of a list when nothing has been added yet', () => {
    render(<UploadQueue rows={[]} onClearFinished={() => {}} />);

    expect(screen.getByText('Files you add appear here.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('renders only lifecycle rows — a staged or rejected file stays in the drop zone, not here', () => {
    const rows: QueueRow[] = [
      { id: '1', fileName: 'staged.pdf', state: { kind: 'staged' } },
      {
        id: '2',
        fileName: 'rejected.exe',
        state: { kind: 'rejected', message: 'Unsupported file type.' },
      },
      { id: '3', fileName: 'memo.docx', state: { kind: 'uploading' } },
      { id: '4', fileName: 'valuation.xlsx', state: { kind: 'uploaded' } },
      {
        id: '5',
        fileName: 'rogue.exe',
        state: { kind: 'failed', message: 'Disk full' },
      },
    ];

    render(<UploadQueue rows={rows} onClearFinished={() => {}} />);

    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.queryByText('staged.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText('rejected.exe')).not.toBeInTheDocument();
    expect(screen.getByText('memo.docx')).toBeInTheDocument();
    expect(screen.getByText('Uploading…')).toBeInTheDocument();
    expect(screen.getByText('valuation.xlsx')).toBeInTheDocument();
    expect(screen.getByText('Uploaded')).toBeInTheDocument();
    expect(screen.getByText('rogue.exe')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    // The message that failed it is on the row, not folded into a summary elsewhere.
    expect(screen.getByText('Disk full')).toBeInTheDocument();
  });

  it('badges a failed row with the rejection tone, not the caution one a pending row carries', () => {
    const rows: QueueRow[] = [
      { id: '1', fileName: 'rogue.exe', state: { kind: 'failed', message: 'Nope.' } },
    ];

    render(<UploadQueue rows={rows} onClearFinished={() => {}} />);

    expect(screen.getByText('Failed').className).toContain('badge--reject');
  });

  it('offers Clear finished only while a terminal row exists, and drops those rows on click', () => {
    const onClearFinished = vi.fn();
    const { rerender } = render(
      <UploadQueue
        rows={[{ id: '1', fileName: 'memo.docx', state: { kind: 'uploading' } }]}
        onClearFinished={onClearFinished}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Clear finished' })).not.toBeInTheDocument();

    rerender(
      <UploadQueue
        rows={[{ id: '1', fileName: 'memo.docx', state: { kind: 'uploaded' } }]}
        onClearFinished={onClearFinished}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear finished' }));

    expect(onClearFinished).toHaveBeenCalledTimes(1);
  });
});
