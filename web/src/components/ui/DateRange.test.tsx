import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import DateRange from './DateRange';
import type { DateRangeValue } from '../../lib/date-range';

const ANY_TIME: DateRangeValue = { range: '', from: '', to: '' };

function ControlledDateRange({
  initial,
  onChange,
}: {
  initial: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <DateRange
      label="Created"
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

describe('DateRange', () => {
  it('names the group by the select label', () => {
    render(<DateRange label="Created" value={ANY_TIME} onChange={() => {}} />);

    const group = screen.getByRole('group', { name: 'Created' });
    expect(within(group).getByRole('combobox', { name: 'Created' })).toBeInTheDocument();
  });

  it('offers five options with exact labels, in order', () => {
    render(<DateRange label="Created" value={ANY_TIME} onChange={() => {}} />);

    const options = within(screen.getByRole('combobox', { name: 'Created' })).getAllByRole(
      'option',
    );
    expect(options.map((option) => option.textContent)).toEqual([
      'Any time',
      'Last 24 hours',
      'Last 7 days',
      'Last 30 days',
      'Custom range',
    ]);
  });

  it('emits a preset key with both dates cleared', () => {
    const onChange = vi.fn();
    render(
      <DateRange
        label="Created"
        value={{ range: 'custom', from: '2026-09-01', to: '2026-09-08' }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: '7d' },
    });

    expect(onChange).toHaveBeenCalledWith({ range: '7d', from: '', to: '' });
  });

  it('emits Any time with both dates cleared', () => {
    const onChange = vi.fn();
    render(
      <DateRange
        label="Created"
        value={{ range: 'custom', from: '2026-09-01', to: '' }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith(ANY_TIME);
  });

  it('reveals From and To on Custom range while focus stays on the select', () => {
    const onChange = vi.fn();
    render(<ControlledDateRange initial={ANY_TIME} onChange={onChange} />);
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();

    const select = screen.getByRole('combobox', { name: 'Created' });
    select.focus();
    fireEvent.change(select, { target: { value: 'custom' } });

    expect(onChange).toHaveBeenCalledWith({ range: 'custom', from: '', to: '' });
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
    expect(select).toHaveFocus();
  });

  it('emits a custom value on a date change', () => {
    const onChange = vi.fn();
    render(
      <DateRange
        label="Created"
        value={{ range: 'custom', from: '', to: '2026-09-08' }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });

    expect(onChange).toHaveBeenCalledWith({
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-08',
    });
  });

  it('renders the date inputs for a custom value and none for a preset', () => {
    const { rerender } = render(
      <DateRange
        label="Created"
        value={{ range: 'custom', from: '2026-09-01', to: '2026-09-08' }}
        onChange={() => {}}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Created' })).toHaveValue('custom');
    expect(screen.getByLabelText('From')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('To')).toHaveValue('2026-09-08');

    rerender(
      <DateRange label="Created" value={{ range: '30d', from: '', to: '' }} onChange={() => {}} />,
    );

    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument();
  });

  it('marks both date inputs invalid, not the group', () => {
    render(
      <DateRange
        label="Created"
        value={{ range: 'custom', from: '', to: '' }}
        onChange={() => {}}
        error="Pick both dates"
      />,
    );

    expect(screen.getByRole('group', { name: 'Created' })).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('From')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('To')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps an intermediate typed year in the input and never emits it', () => {
    const onChange = vi.fn();
    render(
      <DateRange
        label="Created"
        value={{ range: 'custom', from: '', to: '2026-09-08' }}
        onChange={onChange}
      />,
    );

    const fromInput = screen.getByLabelText('From');
    fireEvent.change(fromInput, { target: { value: '0002-09-01' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(fromInput).toHaveValue('0002-09-01');
  });

  it('commits a typed date once it reads as a complete calendar date', () => {
    const onChange = vi.fn();
    render(
      <ControlledDateRange initial={{ range: 'custom', from: '', to: '' }} onChange={onChange} />,
    );

    const fromInput = screen.getByLabelText('From');
    fireEvent.change(fromInput, { target: { value: '0002-09-01' } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(fromInput, { target: { value: '2026-09-01' } });
    expect(onChange).toHaveBeenCalledWith({ range: 'custom', from: '2026-09-01', to: '' });
    expect(fromInput).toHaveValue('2026-09-01');
  });

  it('blocks a From after To, shows the ordering error on From, and never emits the pair', () => {
    const onChange = vi.fn();
    render(
      <ControlledDateRange
        initial={{ range: 'custom', from: '2026-06-01', to: '2026-06-10' }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-06-20' } });

    expect(onChange).not.toHaveBeenCalled();
    const fromField = screen.getByLabelText('From');
    expect(fromField).toHaveValue('2026-06-20');
    expect(fromField).toHaveAttribute('aria-invalid', 'true');
    expect(fromField).toHaveAccessibleDescription('Error:From must be on or before To.');
    const toField = screen.getByLabelText('To');
    expect(toField).not.toHaveAttribute('aria-invalid');
    expect(toField).toHaveValue('2026-06-10');
  });

  it('blocks a To before From, shows the ordering error on To, and never emits the pair', () => {
    const onChange = vi.fn();
    render(
      <ControlledDateRange
        initial={{ range: 'custom', from: '2026-06-10', to: '2026-06-20' }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-06-01' } });

    expect(onChange).not.toHaveBeenCalled();
    const toField = screen.getByLabelText('To');
    expect(toField).toHaveValue('2026-06-01');
    expect(toField).toHaveAttribute('aria-invalid', 'true');
    expect(toField).toHaveAccessibleDescription('Error:From must be on or before To.');
    const fromField = screen.getByLabelText('From');
    expect(fromField).not.toHaveAttribute('aria-invalid');
    expect(fromField).toHaveValue('2026-06-10');
  });

  it('keeps an intermediate three-digit year local and never emits it', () => {
    const onChange = vi.fn();
    render(
      <DateRange
        label="Created"
        value={{ range: 'custom', from: '', to: '2026-09-08' }}
        onChange={onChange}
      />,
    );

    const fromInput = screen.getByLabelText('From');
    fireEvent.change(fromInput, { target: { value: '0202-09-01' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(fromInput).toHaveValue('0202-09-01');
    expect(screen.queryByText('From must be on or before To.')).not.toBeInTheDocument();
  });

  it('drops a blocked intermediate draft when a preset changes the applied value, so it does not resurface in Custom range', () => {
    const onChange = vi.fn();
    render(
      <ControlledDateRange
        initial={{ range: 'custom', from: '', to: '2026-09-08' }}
        onChange={onChange}
      />,
    );

    // A still-typing year stays local; `value.from` stays '' throughout.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '0002-09-01' } });
    expect(onChange).not.toHaveBeenCalled();

    // Last 7 days changes `to` and clears `from`, but `from` was already '' — a draft re-synced
    // per-bound (comparing only against its own prior value) would read that as no change and
    // keep the stale local draft.
    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: '7d' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ range: '7d', from: '', to: '' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Created' }), {
      target: { value: 'custom' },
    });

    expect(screen.getByLabelText('From')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-06-15' } });
    expect(onChange).toHaveBeenCalledWith({ range: 'custom', from: '', to: '2026-06-15' });
  });

  it('accepts equal From and To as an ordered single-day range', () => {
    const onChange = vi.fn();
    render(
      <DateRange
        label="Created"
        value={{ range: 'custom', from: '2026-06-15', to: '' }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-06-15' } });

    expect(onChange).toHaveBeenCalledWith({
      range: 'custom',
      from: '2026-06-15',
      to: '2026-06-15',
    });
  });
});
