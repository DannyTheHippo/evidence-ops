import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import EmptyState from './EmptyState';

describe('EmptyState', () => {
  it('renders the title', () => {
    render(<EmptyState title="No documents yet" />);

    expect(screen.getByText('No documents yet')).toBeInTheDocument();
  });

  it('renders an optional description', () => {
    render(<EmptyState title="No documents yet" description="Upload a file to get started." />);

    expect(screen.getByText('Upload a file to get started.')).toBeInTheDocument();
  });

  it('renders the action slot', () => {
    render(<EmptyState title="No documents yet" action={<button>Upload</button>} />);

    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
  });

  it('renders the title as a heading when a level is given', () => {
    render(<EmptyState title="No documents yet" headingLevel={2} />);

    expect(screen.getByRole('heading', { level: 2, name: 'No documents yet' })).toBeInTheDocument();
  });

  it('renders the title as plain text when no level is given', () => {
    render(<EmptyState title="No documents yet" />);

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});
