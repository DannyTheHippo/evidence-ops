/// <reference types="vite/client" />
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import primitivesCss from '../../styles/primitives.css?raw';
import PasswordInput from './PasswordInput';

describe('PasswordInput', () => {
  it('renders a password input labelled by its label prop', () => {
    render(<PasswordInput label="Password" value="" onChange={() => {}} />);

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('reveals the value as plain text once the toggle is pressed', () => {
    render(<PasswordInput label="Password" value="secret123" onChange={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
  });

  it('hides the value again once the toggle is pressed a second time', () => {
    render(<PasswordInput label="Password" value="secret123" onChange={() => {}} />);

    const toggle = screen.getByRole('button', { name: 'Show password' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('reflects the reveal state through its name alone, with no aria-pressed', () => {
    render(<PasswordInput label="Password" value="secret123" onChange={() => {}} />);

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).not.toHaveAttribute('aria-pressed');

    fireEvent.click(toggle);

    const hide = screen.getByRole('button', { name: 'Hide password' });
    expect(hide).toBe(toggle);
    expect(hide).not.toHaveAttribute('aria-pressed');
    expect(screen.queryByRole('button', { name: 'Show password' })).not.toBeInTheDocument();
  });

  it('gives the toggle the minimum target size through its own password-input-toggle rule', () => {
    const sheet = document.createElement('style');
    sheet.textContent = primitivesCss;
    document.head.append(sheet);

    try {
      render(<PasswordInput label="Password" value="" onChange={() => {}} />);

      const toggle = screen.getByRole('button', { name: 'Show password' });
      expect(toggle).toHaveClass('password-input-toggle');
      const style = getComputedStyle(toggle);
      expect(style.minWidth).toBe('var(--target-min)');
      expect(style.minHeight).toBe('var(--target-min)');
    } finally {
      sheet.remove();
    }
  });

  it('never calls onChange from toggling visibility', () => {
    const onChange = vi.fn();
    render(<PasswordInput label="Password" value="secret123" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('names the toggle by the field it controls', () => {
    render(<PasswordInput label="Password" value="secret123" onChange={() => {}} />);

    const input = screen.getByLabelText('Password');
    const toggle = screen.getByRole('button', { name: 'Show password' });

    expect(toggle).toHaveAttribute('aria-controls', input.id);
  });

  it('reports a typed value through onChange', () => {
    const onChange = vi.fn();
    render(<PasswordInput label="Password" value="" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'abc' } });

    expect(onChange).toHaveBeenCalledWith('abc');
  });
});
