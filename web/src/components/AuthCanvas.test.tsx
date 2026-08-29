import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import AuthCanvas from './AuthCanvas';

describe('AuthCanvas', () => {
  it('renders the title as the page heading, alongside the brand wordmark', () => {
    render(<AuthCanvas title="Sign in">content</AuthCanvas>);

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Evidence Ops')).toBeInTheDocument();
  });

  it('renders children inside the card', () => {
    render(
      <AuthCanvas title="Sign in">
        <p>Card body</p>
      </AuthCanvas>,
    );

    expect(screen.getByText('Card body')).toBeInTheDocument();
  });

  it('renders an optional description below the title', () => {
    render(
      <AuthCanvas title="Sign in" description="Sign in to your account.">
        content
      </AuthCanvas>,
    );

    expect(screen.getByText('Sign in to your account.')).toBeInTheDocument();
  });

  it('renders no description when none is given', () => {
    render(<AuthCanvas title="Sign in">content</AuthCanvas>);

    expect(screen.queryByText('Sign in to your account.')).not.toBeInTheDocument();
  });

  it("renders an optional footer for the page's secondary path", () => {
    render(
      <AuthCanvas title="Sign in" footer={<a href="/invite">Need an account?</a>}>
        content
      </AuthCanvas>,
    );

    expect(screen.getByRole('link', { name: 'Need an account?' })).toBeInTheDocument();
  });

  it('renders no footer when none is given', () => {
    const { container } = render(<AuthCanvas title="Sign in">content</AuthCanvas>);

    expect(container.querySelector('.auth-alt')).not.toBeInTheDocument();
  });

  it('gives the title a tabIndex so it can be a programmatic focus target', () => {
    render(<AuthCanvas title="Sign in">content</AuthCanvas>);

    expect(screen.getByRole('heading', { name: 'Sign in' })).toHaveAttribute('tabindex', '-1');
  });

  it('exposes the title via ref so a caller can move focus there directly', () => {
    const ref = createRef<HTMLHeadingElement>();
    render(
      <AuthCanvas title="Sign in" ref={ref}>
        content
      </AuthCanvas>,
    );

    ref.current?.focus();

    expect(ref.current).toHaveFocus();
  });
});
