import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import ErrorSummary from './ErrorSummary';

describe('ErrorSummary', () => {
  it('renders nothing when there is no field error and no formError', () => {
    const { container } = render(<ErrorSummary errors={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the default heading', () => {
    render(<ErrorSummary errors={[{ id: 'name', message: 'Name is required' }]} />);

    expect(screen.getByRole('heading', { name: 'There is a problem' })).toBeInTheDocument();
  });

  it('accepts a custom heading', () => {
    render(
      <ErrorSummary errors={[{ id: 'name', message: 'Name is required' }]} heading="Fix these" />,
    );

    expect(screen.getByRole('heading', { name: 'Fix these' })).toBeInTheDocument();
  });

  it('renders formError on its own, with an empty error list', () => {
    render(<ErrorSummary errors={[]} formError="Something went wrong." />);

    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
  });

  it('renders a link for every field error', () => {
    render(
      <ErrorSummary
        errors={[
          { id: 'name', message: 'Name is required' },
          { id: 'email', message: 'Email is required' },
        ]}
      />,
    );

    expect(screen.getByRole('link', { name: 'Name is required' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Email is required' })).toBeInTheDocument();
  });

  it('carries no role="alert", since focus is the announcement', () => {
    render(<ErrorSummary errors={[{ id: 'name', message: 'Name is required' }]} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is focusable via tabIndex so a caller can move focus to it programmatically', () => {
    render(<ErrorSummary errors={[{ id: 'name', message: 'Name is required' }]} />);

    const heading = screen.getByRole('heading', { name: 'There is a problem' });
    expect(heading.parentElement).toHaveAttribute('tabindex', '-1');
  });

  it('exposes the container via ref so useFormSubmit can focus it on a failed submit', () => {
    const ref = createRef<HTMLDivElement>();
    render(<ErrorSummary errors={[{ id: 'name', message: 'Name is required' }]} ref={ref} />);

    ref.current?.focus();

    expect(ref.current).toHaveFocus();
  });

  it('moves focus to the referenced field when its link is activated', () => {
    render(
      <>
        <ErrorSummary errors={[{ id: 'name', message: 'Name is required' }]} />
        <input id="name" aria-label="Name" />
      </>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Name is required' }));

    expect(screen.getByLabelText('Name')).toHaveFocus();
  });
});
