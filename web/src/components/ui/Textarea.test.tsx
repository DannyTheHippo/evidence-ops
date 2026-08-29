import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Textarea from './Textarea';

describe('Textarea', () => {
  it('links the label to the textarea via htmlFor/id, so getByLabelText resolves it', () => {
    render(<Textarea label="Notes" value="" onChange={() => {}} />);

    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
  });

  it('calls onChange with the new value', () => {
    const onChange = vi.fn();
    render(<Textarea label="Notes" value="" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'a note' } });

    expect(onChange).toHaveBeenCalledWith('a note');
  });

  it('sets aria-invalid and describes the textarea with the error text', () => {
    render(<Textarea label="Notes" value="" onChange={() => {}} error="Notes is required" />);

    expect(screen.getByLabelText('Notes')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Notes is required', { exact: false })).toBeInTheDocument();
  });

  it('passes rest props through to the underlying textarea', () => {
    render(<Textarea label="Notes" value="" onChange={() => {}} placeholder="Add a note" />);

    expect(screen.getByPlaceholderText('Add a note')).toBeInTheDocument();
  });

  it('uses a caller-supplied id for both the label and the textarea', () => {
    render(<Textarea id="custom-id" label="Notes" value="" onChange={() => {}} />);

    expect(screen.getByLabelText('Notes')).toHaveAttribute('id', 'custom-id');
  });

  it('forwards onBlur to the underlying textarea', () => {
    const onBlur = vi.fn();
    render(<Textarea label="Notes" value="" onChange={() => {}} onBlur={onBlur} />);

    fireEvent.blur(screen.getByLabelText('Notes'));

    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});
