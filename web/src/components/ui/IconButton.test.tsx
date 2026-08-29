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

  // jsdom does not run layout, so getBoundingClientRect/getComputedStyle report no real box
  // metrics here — a pixel-accurate 24x24 assertion is not possible in this environment. This
  // instead pins the structural proxy the real measurement depends on: `btn--icon` is the class
  // `primitives.css` uses to guarantee the WCAG 2.2 (2.5.8) minimum hit target regardless of the
  // icon size a caller passes.
  it('carries the btn--icon class that guarantees a 24x24px minimum hit target', () => {
    render(<IconButton icon={<IconX />} aria-label="Close" />);

    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('btn--icon');
  });

  it('merges a caller-supplied className after btn--icon', () => {
    render(<IconButton icon={<IconX />} aria-label="Close" className="menu-toggle" />);

    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('btn--icon', 'menu-toggle');
  });
});
