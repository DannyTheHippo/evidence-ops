import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Toolbar from './Toolbar';

describe('Toolbar', () => {
  it('renders the start slot', () => {
    render(<Toolbar start={<div>Filter form</div>} />);

    expect(screen.getByText('Filter form')).toBeInTheDocument();
  });

  it('renders the end slot', () => {
    render(<Toolbar end={<span>12 results</span>} />);

    expect(screen.getByText('12 results')).toBeInTheDocument();
  });

  it('renders both slots together', () => {
    render(<Toolbar start={<div>Filter form</div>} end={<span>12 results</span>} />);

    expect(screen.getByText('Filter form')).toBeInTheDocument();
    expect(screen.getByText('12 results')).toBeInTheDocument();
  });

  it('renders nothing when neither slot is supplied', () => {
    const { container } = render(<Toolbar />);

    expect(container).toBeEmptyDOMElement();
  });
});
