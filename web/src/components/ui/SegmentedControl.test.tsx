import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SegmentedControl from './SegmentedControl';

const OPTIONS: { value: 'tracked' | 'inventory'; label: string; count?: number }[] = [
  { value: 'tracked', label: 'Tracked sources' },
  { value: 'inventory', label: 'Repository inventory', count: 12 },
];

describe('SegmentedControl', () => {
  it('marks the active option as pressed', () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value="tracked"
        onChange={() => {}}
        aria-label="Source list"
      />,
    );

    expect(screen.getByRole('button', { name: 'Tracked sources' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Repository inventory' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('calls onChange with the clicked option value', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={OPTIONS}
        value="tracked"
        onChange={onChange}
        aria-label="Source list"
      />,
    );

    screen.getByRole('button', { name: 'Repository inventory' }).click();

    expect(onChange).toHaveBeenCalledWith('inventory');
  });

  it('keeps a count out of the accessible name', () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value="tracked"
        onChange={() => {}}
        aria-label="Source list"
      />,
    );

    expect(screen.getByRole('button', { name: 'Repository inventory' })).toBeInTheDocument();
    expect(screen.getByText('(12)')).toHaveAttribute('aria-hidden', 'true');
  });

  it('announces an option count through its description', () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value="tracked"
        onChange={() => {}}
        aria-label="Source list"
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Repository inventory' }),
    ).toHaveAccessibleDescription('12 items');
    expect(screen.getByRole('button', { name: 'Tracked sources' })).not.toHaveAttribute(
      'aria-describedby',
    );
  });

  it('names the group', () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value="tracked"
        onChange={() => {}}
        aria-label="Source list"
      />,
    );

    expect(screen.getByRole('group', { name: 'Source list' })).toBeInTheDocument();
  });

  it('renders its group with its own class, not the generic control row', () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value="tracked"
        onChange={() => {}}
        aria-label="Source list"
      />,
    );

    const group = screen.getByRole('group', { name: 'Source list' });
    expect(group).toHaveClass('segmented-control');
    expect(group).not.toHaveClass('control-row');
  });
});
