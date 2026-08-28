import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FilterBar from './FilterBar';
import Select from './Select';

const OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'completed', label: 'Completed' },
];

describe('FilterBar', () => {
  it('calls onApply when the form is submitted, not when a child control changes', () => {
    const onApply = vi.fn();
    render(
      <FilterBar onApply={onApply} onClear={() => {}} hasFilter={false}>
        <Select label="Run status" options={OPTIONS} value="" onChange={() => {}} />
      </FilterBar>,
    );

    fireEvent.change(screen.getByLabelText('Run status'), { target: { value: 'completed' } });
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('renders Clear filters only when hasFilter is true, and calls onClear when clicked', () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <FilterBar onApply={() => {}} onClear={onClear} hasFilter={false}>
        <Select label="Run status" options={OPTIONS} value="" onChange={() => {}} />
      </FilterBar>,
    );

    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();

    rerender(
      <FilterBar onApply={() => {}} onClear={onClear} hasFilter={true}>
        <Select label="Run status" options={OPTIONS} value="completed" onChange={() => {}} />
      </FilterBar>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
