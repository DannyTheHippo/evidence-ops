import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Skeleton from './Skeleton';

describe('Skeleton', () => {
  it('mounts the status region before its label', () => {
    // Server rendering never runs effects, so this captures exactly the pre-effect first paint —
    // the region exists and is empty, ahead of the client effect that fills it in.
    const firstPaint = renderToStaticMarkup(<Skeleton label="Loading documents…" />);
    const firstPaintDom = new DOMParser().parseFromString(firstPaint, 'text/html');
    const firstPaintStatus = firstPaintDom.querySelector('[role="status"]');
    expect(firstPaintStatus).not.toBeNull();
    expect(firstPaintStatus?.querySelector('.sr-only')?.textContent).toBe('');

    render(<Skeleton label="Loading documents…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading documents…');
  });

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

  it('defaults to the lines variant', () => {
    render(<Skeleton label="Loading" />);

    const shimmer = screen.getByRole('status').querySelector('[aria-hidden="true"]');
    expect(shimmer).toHaveClass('skeleton-lines');
  });

  it('renders rows shaped like a table when variant is table', () => {
    render(<Skeleton label="Loading rows" variant="table" rows={4} />);

    const shimmer = screen.getByRole('status').querySelector('[aria-hidden="true"]');
    expect(shimmer).toHaveClass('skeleton-table');
    expect(shimmer?.querySelectorAll('.skeleton-row')).toHaveLength(4);
  });

  it('renders label-plus-control pairs when variant is form', () => {
    render(<Skeleton label="Loading form" variant="form" lines={2} />);

    const shimmer = screen.getByRole('status').querySelector('[aria-hidden="true"]');
    expect(shimmer).toHaveClass('skeleton-form');
    expect(shimmer?.querySelectorAll('.skeleton-field')).toHaveLength(2);
    expect(shimmer?.querySelectorAll('.skeleton-field-label')).toHaveLength(2);
    expect(shimmer?.querySelectorAll('.skeleton-field-input')).toHaveLength(2);
  });
});
