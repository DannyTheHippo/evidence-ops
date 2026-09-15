import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Toolbar from './Toolbar';

describe('Toolbar', () => {
  it('renders the view slot alone in the view row', () => {
    const { container } = render(<Toolbar view={<div>View switch</div>} />);

    expect(screen.getByText('View switch').parentElement).toHaveClass(
      'toolbar-row',
      'toolbar-row--view',
    );
    expect(container.querySelector('.toolbar-end')).not.toBeInTheDocument();
    expect(container.querySelector('.toolbar-row--filters')).not.toBeInTheDocument();
  });

  it('renders the end slot alone inside the view row', () => {
    const { container } = render(<Toolbar end={<span>12 results</span>} />);

    const end = screen.getByText('12 results').parentElement;
    expect(end).toHaveClass('toolbar-end');
    expect(end?.parentElement).toHaveClass('toolbar-row--view');
    expect(container.querySelector('.toolbar-row--filters')).not.toBeInTheDocument();
  });

  it('renders the filters slot alone in the filter row, omitting the view row', () => {
    const { container } = render(<Toolbar filters={<div>Filter form</div>} />);

    expect(screen.getByText('Filter form').parentElement).toHaveClass(
      'toolbar-row',
      'toolbar-row--filters',
    );
    expect(container.querySelector('.toolbar-row--view')).not.toBeInTheDocument();
  });

  it('renders all three slots in the order view, end, filters', () => {
    const { container } = render(
      <Toolbar
        view={<div>View switch</div>}
        end={<span>12 results</span>}
        filters={<div>Filter form</div>}
      />,
    );

    const toolbar = container.firstElementChild;
    expect(toolbar).toHaveClass('toolbar');
    const rows = Array.from(toolbar?.children ?? []);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveClass('toolbar-row--view');
    expect(rows[1]).toHaveClass('toolbar-row--filters');

    const view = screen.getByText('View switch');
    const end = screen.getByText('12 results');
    const filters = screen.getByText('Filter form');
    expect(view.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(end.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders nothing when no slot is supplied', () => {
    const { container } = render(<Toolbar />);

    expect(container).toBeEmptyDOMElement();
  });
});
