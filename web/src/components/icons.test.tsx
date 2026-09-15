import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as Icons from './icons';

const iconEntries = Object.entries(Icons);

describe('icons', () => {
  describe.each(iconEntries)('%s', (_name, Icon) => {
    it('renders an svg hidden from the accessibility tree', () => {
      const { container } = render(<Icon />);
      const svg = container.querySelector('svg');

      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg).toHaveAttribute('focusable', 'false');
    });

    it('applies a custom size and className', () => {
      const { container } = render(<Icon size={32} className="custom-icon" />);
      const svg = container.querySelector('svg');

      expect(svg).toHaveAttribute('width', '32');
      expect(svg).toHaveAttribute('height', '32');
      expect(svg).toHaveClass('custom-icon');
    });
  });

  it('renders every glyph on one grid and stroke weight', () => {
    iconEntries.forEach(([, Icon]) => {
      const { container } = render(<Icon />);
      const svg = container.querySelector('svg');

      expect(svg).toHaveAttribute('viewBox', '0 0 16 16');
      expect(svg).toHaveAttribute('stroke-width', '1.5');
    });
  });

  it('renders the directional collapse pair', () => {
    expect(Icons.IconPanelLeftClose).toBeDefined();
    expect(Icons.IconPanelLeftOpen).toBeDefined();
  });
});
