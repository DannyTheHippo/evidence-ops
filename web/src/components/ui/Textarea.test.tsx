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

  it('sets aria-invalid and exposes the error via role=alert', () => {
    render(<Textarea label="Notes" value="" onChange={() => {}} error="Notes is required" />);

    expect(screen.getByLabelText('Notes')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Notes is required');
  });

  it('passes rest props through to the underlying textarea', () => {
    render(<Textarea label="Notes" value="" onChange={() => {}} placeholder="Add a note" />);

    expect(screen.getByPlaceholderText('Add a note')).toBeInTheDocument();
  });
});
