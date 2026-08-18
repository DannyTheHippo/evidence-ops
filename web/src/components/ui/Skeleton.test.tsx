import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Skeleton from './Skeleton';

describe('Skeleton', () => {
  it('exposes a status region containing the label, with the shimmer hidden from a11y', () => {
    render(<Skeleton label="Loading documents…" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading documents…');
    expect(status.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('renders the requested number of shimmer lines', () => {
    render(<Skeleton label="Loading" lines={5} />);

    const shimmer = screen.getByRole('status').querySelector('[aria-hidden="true"]');
    expect(shimmer?.children).toHaveLength(5);
  });
});
