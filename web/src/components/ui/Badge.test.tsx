import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Badge from './Badge';

describe('Badge', () => {
  it.each([
    ['verified', 'Verified', 'badge--strong'],
    ['caution', 'Caution', 'badge--possible'],
    ['rejected', 'Rejected', 'badge--reject'],
    ['info', 'Info', 'badge--info'],
    ['neutral', 'Neutral', 'badge--neutral'],
  ] as const)('renders its children for tone %s, mapped to %s', (tone, label, toneClass) => {
    render(<Badge tone={tone}>{label}</Badge>);

    const badge = screen.getByText(label);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('badge', toneClass);
  });
});
