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

  it('wraps actions in a single element', () => {
    render(
      <PageHeader
        title="Widgets"
        actions={
          <>
            <button>New widget</button>
            <button>Export</button>
          </>
        }
      />,
    );

    const newWidget = screen.getByRole('button', { name: 'New widget' });
    const exportButton = screen.getByRole('button', { name: 'Export' });
    expect(newWidget.parentElement).toBe(exportButton.parentElement);
    expect(newWidget.parentElement).toHaveClass('page-head-actions');
  });

  it('makes the heading programmatically focusable', () => {
    render(<PageHeader title="Widgets" />);

    expect(screen.getByRole('heading', { name: 'Widgets' })).toHaveAttribute('tabIndex', '-1');
  });
});
