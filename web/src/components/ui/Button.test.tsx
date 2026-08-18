import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Button from './Button';

describe('Button', () => {
  it('renders with the accessible name from its children and defaults to type="button"', () => {
    render(<Button>Save changes</Button>);

    const button = screen.getByRole('button', { name: 'Save changes' });
    expect(button).toHaveAttribute('type', 'button');
  });

  it('lets a caller-supplied type="submit" win', () => {
    render(<Button type="submit">Submit</Button>);

    expect(screen.getByRole('button', { name: 'Submit' })).toHaveAttribute('type', 'submit');
  });

  it('reflects the disabled prop', () => {
    render(<Button disabled>Disabled</Button>);

    expect(screen.getByRole('button', { name: 'Disabled' })).toBeDisabled();
  });

  it('forwards onClick and merges a caller-supplied className', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} className="custom">
        Click me
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Click me' });
    button.click();

    expect(onClick).toHaveBeenCalledOnce();
    expect(button).toHaveClass('btn', 'btn--primary', 'custom');
  });
});
