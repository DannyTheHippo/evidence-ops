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

  it('sets aria-invalid and describes the input with the error text', () => {
    render(<Input label="Name" value="" onChange={() => {}} error="Name is required" />);

    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Name is required', { exact: false })).toBeInTheDocument();
  });

  it('passes rest props through to the underlying input', () => {
    render(<Input label="Name" value="" onChange={() => {}} placeholder="Add a name" />);

    expect(screen.getByPlaceholderText('Add a name')).toBeInTheDocument();
  });

  it('uses a caller-supplied id for both the label and the input', () => {
    render(<Input id="custom-id" label="Name" value="" onChange={() => {}} />);

    expect(screen.getByLabelText('Name')).toHaveAttribute('id', 'custom-id');
  });

  it('forwards onBlur to the underlying input', () => {
    const onBlur = vi.fn();
    render(<Input label="Name" value="" onChange={() => {}} onBlur={onBlur} />);

    fireEvent.blur(screen.getByLabelText('Name'));

    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});
