import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DescriptionList from './DescriptionList';

const ITEMS = [
  { term: 'Owner', description: 'Jane Doe' },
  { term: 'Path', description: '/contracts/msa.pdf' },
];

describe('DescriptionList', () => {
  it('renders a real definition list', () => {
    const { container } = render(<DescriptionList items={ITEMS} />);

    expect(container.querySelector('dl')).toBeInTheDocument();
    expect(container.querySelectorAll('dt')).toHaveLength(2);
    expect(container.querySelectorAll('dd')).toHaveLength(2);
  });

  it('renders every term and description', () => {
    render(<DescriptionList items={ITEMS} />);

    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Path')).toBeInTheDocument();
    expect(screen.getByText('/contracts/msa.pdf')).toBeInTheDocument();
  });

  it('applies the two-column modifier when requested', () => {
    const { container } = render(<DescriptionList items={ITEMS} columns={2} />);

    expect(container.querySelector('dl')).toHaveClass('description-list--2col');
  });

  it('omits the two-column modifier by default', () => {
    const { container } = render(<DescriptionList items={ITEMS} />);

    expect(container.querySelector('dl')).not.toHaveClass('description-list--2col');
  });
});
