import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Panel from './Panel';

describe('Panel', () => {
  it('renders a focusable, named region around its children', () => {
    render(
      <Panel aria-label="Answered questions and their grounding">
        <table>
          <caption>Answered questions and their grounding</caption>
        </table>
      </Panel>,
    );

    const region = screen.getByRole('region', { name: 'Answered questions and their grounding' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.tagName).toBe('SECTION');
  });

  it('merges a caller class with the panel class', () => {
    render(
      <Panel aria-label="Sources" className="extra">
        <p>Rows</p>
      </Panel>,
    );

    expect(screen.getByRole('region', { name: 'Sources' })).toHaveClass('panel', 'extra');
  });
});
