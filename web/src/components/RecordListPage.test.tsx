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

  it('renders only the error region for an error status', () => {
    renderWithStatus({ kind: 'error', message: 'Failed to load widgets' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Failed to load widgets');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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
});
