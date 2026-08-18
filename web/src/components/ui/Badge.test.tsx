import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Badge from './Badge';

describe('Badge', () => {
  it.each([
    ['verified', 'Verified'],
    ['caution', 'Caution'],
    ['rejected', 'Rejected'],
    ['info', 'Info'],
    ['neutral', 'Neutral'],
  ] as const)('renders its children for tone %s', (tone, label) => {
    render(<Badge tone={tone}>{label}</Badge>);

    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
