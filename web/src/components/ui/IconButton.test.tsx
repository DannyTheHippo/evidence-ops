import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { IconX } from '../icons';
import IconButton from './IconButton';

describe('IconButton', () => {
  it('is found by its aria-label', () => {
    render(<IconButton icon={<IconX />} aria-label="Close" />);

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('forwards ref to the underlying button element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<IconButton icon={<IconX />} aria-label="Close" ref={ref} />);

    expect(ref.current).toBe(screen.getByRole('button', { name: 'Close' }));
  });
});
