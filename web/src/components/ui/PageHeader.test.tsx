import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PageHeader from './PageHeader';

describe('PageHeader', () => {
  it('renders the title', () => {
    render(<PageHeader title="Widgets" />);

    expect(screen.getByRole('heading', { name: 'Widgets' })).toBeInTheDocument();
  });

  it('renders an optional eyebrow and description', () => {
    render(<PageHeader eyebrow="Review" title="Widgets" description="All widgets." />);

    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('All widgets.')).toBeInTheDocument();
  });

  it('omits the eyebrow and description when absent', () => {
    render(<PageHeader title="Widgets" />);

    expect(screen.queryByText('Review')).not.toBeInTheDocument();
  });

  it('renders the actions slot', () => {
    render(<PageHeader title="Widgets" actions={<button>New widget</button>} />);

    expect(screen.getByRole('button', { name: 'New widget' })).toBeInTheDocument();
  });
});
