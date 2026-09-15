import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FilterBar from './FilterBar';
import Select from './Select';

const OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'completed', label: 'Completed' },
];

describe('FilterBar', () => {
  it('renders no Apply filters button', () => {
    render(
      <FilterBar onClear={() => {}} hasFilter={true}>
        <Select label="Run status" options={OPTIONS} value="completed" onChange={() => {}} />
      </FilterBar>,
    );

    expect(screen.queryByRole('button', { name: 'Apply filters' })).not.toBeInTheDocument();
  });

  // jsdom does not implement implicit submission, so the submit event a browser fires for Enter
  // in a form's only text field is dispatched on the form directly.
  it('prevents the browser default submit, without reloading, for a lone text input', () => {
    render(
      <FilterBar onClear={() => {}} hasFilter={false}>
        <input aria-label="Search" defaultValue="" />
      </FilterBar>,
    );

    const form = screen.getByRole('form', { name: 'Filters' });
    expect(form).toContainElement(screen.getByRole('textbox', { name: 'Search' }));
    const notPrevented = fireEvent.submit(form);

    expect(notPrevented).toBe(false);
  });

  it('renders Clear filters only when hasFilter is true, calls onClear and focuses the first control', () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <FilterBar onClear={onClear} hasFilter={false}>
        <Select label="Run status" options={OPTIONS} value="" onChange={() => {}} />
      </FilterBar>,
    );

    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();

    rerender(
      <FilterBar onClear={onClear} hasFilter={true}>
        <Select label="Run status" options={OPTIONS} value="completed" onChange={() => {}} />
      </FilterBar>,
    );

    const clearButton = screen.getByRole('button', { name: 'Clear filters' });
    expect(clearButton).toHaveAttribute('type', 'button');
    expect(clearButton.parentElement).toBe(screen.getByRole('form', { name: 'Filters' }));
    expect(clearButton.parentElement?.lastElementChild).toBe(clearButton);

    fireEvent.click(clearButton);

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Run status')).toHaveFocus();
  });

  it('names the filter form', () => {
    render(
      <FilterBar onClear={() => {}} hasFilter={false}>
        <Select label="Run status" options={OPTIONS} value="" onChange={() => {}} />
      </FilterBar>,
    );

    expect(screen.getByRole('form', { name: 'Filters' })).toBeInTheDocument();
  });

  it('accepts a page-specific filter name', () => {
    render(
      <FilterBar label="Run filters" onClear={() => {}} hasFilter={false}>
        <Select label="Run status" options={OPTIONS} value="" onChange={() => {}} />
      </FilterBar>,
    );

    expect(screen.getByRole('form', { name: 'Run filters' })).toBeInTheDocument();
  });
});
