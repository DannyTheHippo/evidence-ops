import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import LinkButton from './LinkButton';

describe('LinkButton', () => {
  it('renders a react-router Link when given to', () => {
    render(
      <MemoryRouter>
        <LinkButton to="/ask">Ask a question</LinkButton>
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Ask a question' });
    expect(link).toHaveAttribute('href', '/ask');
  });

  it('renders a plain anchor when given href', () => {
    render(<LinkButton href="mailto:person@example.com">Email invite</LinkButton>);

    const link = screen.getByRole('link', { name: 'Email invite' });
    expect(link).toHaveAttribute('href', 'mailto:person@example.com');
  });

  it('defaults to the primary, md classes and merges a caller className last', () => {
    render(
      <MemoryRouter>
        <LinkButton to="/" className="custom">
          Go to Home
        </LinkButton>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Go to Home' })).toHaveClass(
      'btn',
      'btn--primary',
      'custom',
    );
  });

  it('applies the secondary and sm variant classes', () => {
    render(
      <MemoryRouter>
        <LinkButton to="/answers" variant="secondary" size="sm">
          Back to answers
        </LinkButton>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Back to answers' })).toHaveClass(
      'btn',
      'btn--secondary',
      'btn--sm',
    );
  });
});
