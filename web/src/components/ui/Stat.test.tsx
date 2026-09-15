import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import Stat from './Stat';

describe('Stat', () => {
  it('renders the label and value', () => {
    render(<Stat label="Documents" value={128} />);

    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
  });

  it('renders an optional hint', () => {
    render(<Stat label="Documents" value={128} hint="12 added this week" />);

    expect(screen.getByText('12 added this week')).toBeInTheDocument();
  });

  it('applies a tone modifier to the value', () => {
    render(<Stat label="Failed runs" value={3} tone="rejected" />);

    expect(screen.getByText('3')).toHaveClass('stat-row-value--rejected');
  });

  it('omits the tone modifier for the default tone', () => {
    render(<Stat label="Documents" value={128} />);

    expect(screen.getByText('128')).not.toHaveClass('stat-row-value--neutral');
  });

  it('renders a prose value without the numeric register', () => {
    render(<Stat label="Default interval" value="Every 6 hours" kind="text" />);

    const valueEl = screen.getByText('Every 6 hours');
    expect(valueEl).toHaveClass('stat-row-value--text');
    expect(valueEl).not.toHaveClass('mono');
  });

  it('renders as a link to its detail view when to is supplied', () => {
    render(
      <MemoryRouter>
        <Stat label="Documents" value={128} to="/documents" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /Documents.*128/s })).toHaveAttribute(
      'href',
      '/documents',
    );
  });
});
