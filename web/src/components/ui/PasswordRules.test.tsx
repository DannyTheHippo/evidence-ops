import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PasswordRules, { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './PasswordRules';

describe('PasswordRules', () => {
  it('states the exact length constraint', () => {
    render(<PasswordRules password="" />);

    expect(
      screen.getByText(`${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`, {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  // IconCheck is aria-hidden and renders as a plain svg, not an accessible role — its presence is
  // the only signal that the rule reads as met, so these assert on the container rather than a query.
  it('marks the rule unmet for a password shorter than the minimum', () => {
    const { container } = render(<PasswordRules password="short" />);

    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  it('marks the rule met once the password is within range', () => {
    const { container } = render(<PasswordRules password="a-valid-password" />);

    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('marks the rule unmet for a password longer than the maximum', () => {
    const { container } = render(<PasswordRules password={'a'.repeat(PASSWORD_MAX_LENGTH + 1)} />);

    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  it('states the met rule in text', () => {
    const { container } = render(<PasswordRules password="a-valid-password" />);

    expect(container.querySelector('[aria-live]')).toHaveTextContent('met');
  });
});
