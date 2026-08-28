import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Input from './Input';

describe('Input', () => {
  it('links the label to the input via htmlFor/id, so getByLabelText resolves it', () => {
    render(<Input label="Name" value="" onChange={() => {}} />);

    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('calls onChange with the new value', () => {
    const onChange = vi.fn();
    render(<Input label="Name" value="" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'a name' } });

    expect(onChange).toHaveBeenCalledWith('a name');
  });

  it('sets aria-invalid and exposes the error via role=alert', () => {
    render(<Input label="Name" value="" onChange={() => {}} error="Name is required" />);

    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
  });

  it('passes rest props through to the underlying input', () => {
    render(<Input label="Name" value="" onChange={() => {}} placeholder="Add a name" />);

    expect(screen.getByPlaceholderText('Add a name')).toBeInTheDocument();
  });
});
