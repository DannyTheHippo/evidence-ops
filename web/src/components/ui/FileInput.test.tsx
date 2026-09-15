import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FileInput from './FileInput';

describe('FileInput', () => {
  it('opens the picker from the keyboard', () => {
    // The zone is a native <label htmlFor> around the file input, so the input itself carries the
    // browser's own Enter/Space-opens-the-picker behaviour; jsdom does not implement that native
    // file-dialog activation, so this pins the association a real browser relies on instead.
    render(
      <FileInput
        label="Files"
        accept=".pdf"
        files={[]}
        onFilesAdded={() => {}}
        onFileRemoved={() => {}}
      />,
    );

    const input = screen.getByLabelText('Files', { selector: 'input', exact: false });
    expect(input).toHaveAttribute('type', 'file');
    expect(input).not.toHaveAttribute('disabled');
    expect(input).toHaveAccessibleName('Files');
  });

  it('describes the drop zone with the drag instruction, then the hint', () => {
    render(
      <FileInput
        label="Files"
        hint="Up to 10 files, 25 MB each."
        accept=".pdf"
        files={[]}
        onFilesAdded={() => {}}
        onFileRemoved={() => {}}
      />,
    );

    const input = screen.getByLabelText('Files', { selector: 'input', exact: false });
    expect(input).toHaveAccessibleDescription(
      'Drag files here, or press Enter to browse Up to 10 files, 25 MB each.',
    );
  });

  it('keeps the drag state through a child dragleave', () => {
    const { container } = render(
      <FileInput
        label="Files"
        accept=".pdf"
        files={[]}
        onFilesAdded={() => {}}
        onFileRemoved={() => {}}
      />,
    );
    const zone = container.querySelector('.file-input') as HTMLElement;
    const child = zone.querySelector('span') as HTMLElement;

    fireEvent.dragEnter(zone);
    expect(zone).toHaveClass('file-input--dragging');

    // Entering the child bubbles a second dragenter before the browser fires dragleave on the
    // zone for the pointer leaving it — the counter this models never drops to zero here.
    fireEvent.dragEnter(child);
    fireEvent.dragLeave(zone);
    expect(zone).toHaveClass('file-input--dragging');

    fireEvent.dragLeave(child);
    expect(zone).not.toHaveClass('file-input--dragging');
  });

  it('removes a queued file by row', () => {
    const onFileRemoved = vi.fn();
    const file = new File(['content'], 'rent-roll.pdf', { type: 'application/pdf' });
    render(
      <FileInput
        label="Files"
        accept=".pdf"
        files={[{ file }]}
        onFilesAdded={() => {}}
        onFileRemoved={onFileRemoved}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove rent-roll.pdf' }));

    expect(onFileRemoved).toHaveBeenCalledWith(0);
  });

  it("shows a staged file's formatted size beside its name, and keeps the remove button's name", () => {
    const file = new File(['content'], 'rent-roll.pdf', { type: 'application/pdf' });
    render(
      <FileInput
        label="Files"
        accept=".pdf"
        files={[{ file }]}
        onFilesAdded={() => {}}
        onFileRemoved={() => {}}
      />,
    );

    expect(screen.getByText('rent-roll.pdf')).toBeInTheDocument();
    expect(screen.getByText('7 B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove rent-roll.pdf' })).toBeInTheDocument();
  });

  it('announces the queue as a list', () => {
    const files = [
      { file: new File(['a'], 'a.pdf') },
      { file: new File(['b'], 'b.pdf'), error: 'Unsupported file type.' },
    ];
    render(
      <FileInput
        label="Files"
        accept=".pdf"
        files={files}
        onFilesAdded={() => {}}
        onFileRemoved={() => {}}
      />,
    );

    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Unsupported file type.')).toBeInTheDocument();
  });

  it('uses a caller-supplied id for the label, the input, and a bound error', () => {
    render(
      <FileInput
        id="f-file"
        label="Files"
        accept=".pdf"
        error="Too large."
        files={[]}
        onFilesAdded={() => {}}
        onFileRemoved={() => {}}
      />,
    );

    const input = screen.getByLabelText('Files', { selector: 'input', exact: false });
    expect(input).toHaveAttribute('id', 'f-file');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      'Drag files here, or press Enter to browse Error:Too large.',
    );
  });

  it('focuses the sr-only input from outside, the way a failed submit does', () => {
    const { container } = render(
      <FileInput
        id="f-file"
        label="Files"
        accept=".pdf"
        files={[]}
        onFilesAdded={() => {}}
        onFileRemoved={() => {}}
      />,
    );
    const zone = container.querySelector('.file-input') as HTMLElement;

    // Mirrors useFormSubmit's own focus call: `document.getElementById(id)?.focus()`.
    document.getElementById('f-file')?.focus();

    const input = screen.getByLabelText('Files', { selector: 'input', exact: false });
    expect(input).toHaveFocus();
    expect(zone).toContainElement(document.activeElement as HTMLElement);
  });

  it('forwards name and onBlur to the underlying input', () => {
    const onBlur = vi.fn();
    render(
      <FileInput
        name="documents"
        label="Files"
        accept=".pdf"
        files={[]}
        onFilesAdded={() => {}}
        onFileRemoved={() => {}}
        onBlur={onBlur}
      />,
    );

    const input = screen.getByLabelText('Files', { selector: 'input', exact: false });
    expect(input).toHaveAttribute('name', 'documents');

    fireEvent.blur(input);

    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('renders the "(optional)" suffix as part of the accessible name and forwards width', () => {
    const { container } = render(
      <FileInput
        label="Files"
        optional
        width="sm"
        accept=".pdf"
        files={[]}
        onFilesAdded={() => {}}
        onFileRemoved={() => {}}
      />,
    );

    const input = screen.getByLabelText('Files (optional)', { selector: 'input', exact: false });
    expect(input).toBeInTheDocument();
    expect(input).toHaveAccessibleName('Files (optional)');
    expect(container.querySelector('.field')).toHaveClass('field--sm');
  });
});
