import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SplitView from './SplitView';

describe('SplitView', () => {
  it('keeps both panes in the document as labelled regions, primary before secondary', () => {
    render(
      <SplitView
        primary={<p>Queue list</p>}
        secondary={<p>Answer detail</p>}
        primaryLabel="Queue"
        secondaryLabel="Detail"
        ratio="queue"
      />,
    );

    const primary = screen.getByRole('region', { name: 'Queue' });
    const secondary = screen.getByRole('region', { name: 'Detail' });
    expect(primary).toBeInTheDocument();
    expect(secondary).toBeInTheDocument();
    expect(screen.getByText('Queue list')).toBeInTheDocument();
    expect(screen.getByText('Answer detail')).toBeInTheDocument();

    // primary precedes secondary in source order, which is what stacking on a narrow screen
    // relies on to put the queue above the detail rather than the reverse.
    expect(
      primary.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('applies the ratio modifier class for each of the three ratios', () => {
    const { container, rerender } = render(
      <SplitView
        primary={<p>P</p>}
        secondary={<p>S</p>}
        primaryLabel="Primary"
        secondaryLabel="Secondary"
        ratio="queue"
      />,
    );
    expect(container.querySelector('.split-view')).toHaveClass('split-view--queue');

    rerender(
      <SplitView
        primary={<p>P</p>}
        secondary={<p>S</p>}
        primaryLabel="Primary"
        secondaryLabel="Secondary"
        ratio="even"
      />,
    );
    expect(container.querySelector('.split-view')).toHaveClass('split-view--even');

    rerender(
      <SplitView
        primary={<p>P</p>}
        secondary={<p>S</p>}
        primaryLabel="Primary"
        secondaryLabel="Secondary"
        ratio="reader"
      />,
    );
    expect(container.querySelector('.split-view')).toHaveClass('split-view--reader');
  });
});
