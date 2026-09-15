import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import RecordListPage, { type RecordListStatus } from './RecordListPage';

const baseProps = {
  eyebrow: 'Review',
  title: 'Widgets',
  description: 'All widgets in this tenant.',
};

function renderWithStatus(status: RecordListStatus, children: ReactNode = <p>Body</p>) {
  return render(
    <RecordListPage {...baseProps} status={status}>
      {children}
    </RecordListPage>,
  );
}

describe('RecordListPage', () => {
  it('renders the header', () => {
    renderWithStatus({ kind: 'ready' });

    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Widgets' })).toBeInTheDocument();
    expect(screen.getByText('All widgets in this tenant.')).toBeInTheDocument();
  });

  it('renders only the loading region for a loading status', () => {
    renderWithStatus({ kind: 'loading' });

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });

  it('renders a custom loading label when supplied', () => {
    renderWithStatus({ kind: 'loading', label: 'Fetching widgets…' });

    expect(screen.getByText('Fetching widgets…')).toBeInTheDocument();
  });

  it('renders only the alert for a blank status with an error', () => {
    render(
      <RecordListPage {...baseProps} status={{ kind: 'blank' }} error="Failed to load widgets">
        <p>Body</p>
      </RecordListPage>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Failed to load widgets');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });

  it('renders a page error as an alert beside ready rows, keeping existing rows', () => {
    render(
      <RecordListPage {...baseProps} status={{ kind: 'ready' }} error="Failed to refresh widgets">
        <p>Body</p>
      </RecordListPage>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Failed to refresh widgets');
    expect(alert).toHaveClass('alert--rejected');
    expect(screen.getByText('Body')).toBeInTheDocument();
  });

  it('renders the alert alongside the empty state when a filter apply fails on an already-empty result', () => {
    render(
      <RecordListPage
        {...baseProps}
        status={{ kind: 'empty', title: 'No widgets yet' }}
        error="Failed to apply filter"
      >
        <p>Body</p>
      </RecordListPage>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to apply filter');
    expect(screen.getByText('No widgets yet')).toBeInTheDocument();
  });

  it('renders no body region for a blank status without an error', () => {
    renderWithStatus({ kind: 'blank' });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });

  it('renders only the empty region for an empty status', () => {
    renderWithStatus({
      kind: 'empty',
      title: 'No widgets yet',
      description: 'Add one to see it here.',
    });

    expect(screen.getByText('No widgets yet')).toBeInTheDocument();
    expect(screen.getByText('Add one to see it here.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });

  it('renders children only for a ready status', () => {
    renderWithStatus({ kind: 'ready' });

    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the actions slot when supplied and omits it when absent', () => {
    const { rerender } = render(
      <RecordListPage
        {...baseProps}
        status={{ kind: 'ready' }}
        actions={<button>New widget</button>}
      >
        <p>Body</p>
      </RecordListPage>,
    );

    expect(screen.getByRole('button', { name: 'New widget' })).toBeInTheDocument();

    rerender(
      <RecordListPage {...baseProps} status={{ kind: 'ready' }}>
        <p>Body</p>
      </RecordListPage>,
    );

    expect(screen.queryByRole('button', { name: 'New widget' })).not.toBeInTheDocument();
  });

  it('renders the filters slot when supplied and omits it when absent', () => {
    const { rerender } = render(
      <RecordListPage {...baseProps} status={{ kind: 'ready' }} filters={<div>Filter form</div>}>
        <p>Body</p>
      </RecordListPage>,
    );

    expect(screen.getByText('Filter form')).toBeInTheDocument();

    rerender(
      <RecordListPage {...baseProps} status={{ kind: 'ready' }}>
        <p>Body</p>
      </RecordListPage>,
    );

    expect(screen.queryByText('Filter form')).not.toBeInTheDocument();
  });

  it('renders view and toolbarEnd in the first toolbar row and filters in the second', () => {
    render(
      <RecordListPage
        {...baseProps}
        status={{ kind: 'ready' }}
        view={<div>View switch</div>}
        toolbarEnd={<span>12 results</span>}
        filters={<div>Filter form</div>}
      >
        <p>Body</p>
      </RecordListPage>,
    );

    const viewRow = screen.getByText('View switch').parentElement;
    expect(viewRow).toHaveClass('toolbar-row--view');
    expect(viewRow).toContainElement(screen.getByText('12 results'));

    const filterRow = screen.getByText('Filter form').parentElement;
    expect(filterRow).toHaveClass('toolbar-row--filters');
    expect(viewRow?.nextElementSibling).toBe(filterRow);
  });

  it('renders the lead slot before the toolbar and omits it when absent', () => {
    const { rerender } = render(
      <RecordListPage
        {...baseProps}
        status={{ kind: 'ready' }}
        lead={<p>Composer</p>}
        filters={<div>Filter form</div>}
      >
        <p>Body</p>
      </RecordListPage>,
    );

    const lead = screen.getByText('Composer');
    const filterForm = screen.getByText('Filter form');
    expect(
      lead.compareDocumentPosition(filterForm) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    rerender(
      <RecordListPage {...baseProps} status={{ kind: 'ready' }} filters={<div>Filter form</div>}>
        <p>Body</p>
      </RecordListPage>,
    );

    expect(screen.queryByText('Composer')).not.toBeInTheDocument();
  });

  it('renders the footer slot after the status region, under every status kind', () => {
    const statuses: RecordListStatus[] = [
      { kind: 'loading' },
      { kind: 'blank' },
      { kind: 'empty', title: 'No widgets yet' },
      { kind: 'ready' },
    ];

    for (const status of statuses) {
      const { unmount } = render(
        <RecordListPage {...baseProps} status={status} footer={<p>Pager</p>}>
          <p>Body</p>
        </RecordListPage>,
      );

      expect(screen.getByText('Pager')).toBeInTheDocument();
      unmount();
    }
  });
});
