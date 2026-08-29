import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PasswordInput from './PasswordInput';

describe('PasswordInput', () => {
  it('renders a password input labelled by its label prop', () => {
    render(<PasswordInput label="Password" value="" onChange={() => {}} />);

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('reveals the value as plain text once the toggle is pressed', () => {
    render(<PasswordInput label="Password" value="secret123" onChange={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show' }));

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
  });

  it('hides the value again once the toggle is pressed a second time', () => {
    render(<PasswordInput label="Password" value="secret123" onChange={() => {}} />);

    const toggle = screen.getByRole('button', { name: 'Show' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('reflects the reveal state via aria-pressed', () => {
    render(<PasswordInput label="Password" value="secret123" onChange={() => {}} />);

    const toggle = screen.getByRole('button', { name: 'Show' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('carries the btn--icon class that guarantees a 24x24px minimum hit target', () => {
    render(<PasswordInput label="Password" value="" onChange={() => {}} />);

    expect(screen.getByRole('button', { name: 'Show' })).toHaveClass('btn--icon');
  });

  it('never calls onChange from toggling visibility', () => {
    const onChange = vi.fn();
    render(<PasswordInput label="Password" value="secret123" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a typed value through onChange', () => {
    const onChange = vi.fn();
    render(<PasswordInput label="Password" value="" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'abc' } });

    expect(onChange).toHaveBeenCalledWith('abc');
  });
});
