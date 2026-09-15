import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Checkbox from './Checkbox';

describe('Checkbox', () => {
  it('toggles by its label text', () => {
    const onChange = vi.fn();
    render(<Checkbox label="Include archived" checked={false} onChange={onChange} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Include archived' }));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('keeps the hint out of the accessible name', () => {
    render(
      <Checkbox
        label="Include archived"
        hint="Adds records closed more than a year ago"
        checked={false}
        onChange={() => {}}
      />,
    );

    const checkbox = screen.getByRole('checkbox', { name: 'Include archived' });
    expect(checkbox).toHaveAccessibleDescription('Adds records closed more than a year ago');
  });
});
