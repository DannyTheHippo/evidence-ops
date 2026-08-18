import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IconX } from '../icons';
import IconButton from './IconButton';

describe('IconButton', () => {
  it('is found by its aria-label', () => {
    render(<IconButton icon={<IconX />} aria-label="Close" />);

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});
