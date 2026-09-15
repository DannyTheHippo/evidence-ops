import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RadioGroup from './RadioGroup';

const options = [
  { value: 'tracked', label: 'Tracked' },
  { value: 'catalogued', label: 'Catalogued only', hint: 'Recorded but not monitored for changes' },
];

describe('RadioGroup', () => {
  it('renders the legend and one radio per option', () => {
    render(<RadioGroup legend="Tracking" options={options} value="tracked" onChange={() => {}} />);

    expect(screen.getByRole('group', { name: 'Tracking' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Tracked' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Catalogued only/ })).toBeInTheDocument();
  });

  it('checks the radio matching the current value', () => {
    render(
      <RadioGroup legend="Tracking" options={options} value="catalogued" onChange={() => {}} />,
    );

    expect(screen.getByRole('radio', { name: 'Tracked' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Catalogued only/ })).toBeChecked();
  });

  it('calls onChange with the selected option value', () => {
    const onChange = vi.fn();
    render(<RadioGroup legend="Tracking" options={options} value="tracked" onChange={onChange} />);

    fireEvent.click(screen.getByRole('radio', { name: /Catalogued only/ }));

    expect(onChange).toHaveBeenCalledWith('catalogued');
  });

  it('renders a hint beside the option it describes', () => {
    render(<RadioGroup legend="Tracking" options={options} value="tracked" onChange={() => {}} />);

    expect(screen.getByText('Recorded but not monitored for changes')).toBeInTheDocument();
  });

  it('puts the caller-supplied id on the first radio', () => {
    render(
      <RadioGroup
        legend="Tracking"
        options={options}
        value="tracked"
        onChange={() => {}}
        id="tracking"
      />,
    );

    expect(screen.getByRole('radio', { name: 'Tracked' })).toHaveAttribute('id', 'tracking');
  });

  it('describes the group via aria-describedby when it carries an error', () => {
    render(
      <RadioGroup
        legend="Tracking"
        options={options}
        value="tracked"
        onChange={() => {}}
        id="tracking"
        error="Choose a tracking state"
      />,
    );

    const group = screen.getByRole('group', { name: 'Tracking' });
    const errorEl = screen.getByText('Choose a tracking state', { exact: false });
    expect(group.getAttribute('aria-describedby')).toBe(errorEl.id);
  });

  it('marks each radio invalid rather than the fieldset', () => {
    render(
      <RadioGroup
        legend="Tracking"
        options={options}
        value="tracked"
        onChange={() => {}}
        error="Choose a tracking state"
      />,
    );

    const group = screen.getByRole('group', { name: 'Tracking' });
    expect(group).not.toHaveAttribute('aria-invalid');
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-invalid', 'true');
    }
  });

  it('keeps an option hint out of the radio accessible name', () => {
    render(<RadioGroup legend="Tracking" options={options} value="tracked" onChange={() => {}} />);

    const radio = screen.getByRole('radio', { name: 'Catalogued only' });
    expect(radio).toHaveAccessibleDescription('Recorded but not monitored for changes');
  });

  it('renders one label per option beside its control', () => {
    render(<RadioGroup legend="Tracking" options={options} value="tracked" onChange={() => {}} />);

    for (const option of options) {
      const radio = screen.getByRole('radio', { name: option.label });
      const label = radio.closest('label');
      expect(label).toHaveClass('radio-group-option-label');
      expect(label?.parentElement).toHaveClass('radio-group-option');
    }
  });

  it('does not fire onBlur when focus moves between two radios in the same group', () => {
    const onBlur = vi.fn();
    render(
      <RadioGroup
        legend="Tracking"
        options={options}
        value="tracked"
        onChange={() => {}}
        onBlur={onBlur}
      />,
    );

    const [first, second] = screen.getAllByRole('radio');
    fireEvent.focusOut(first, { relatedTarget: second });

    expect(onBlur).not.toHaveBeenCalled();
  });

  it('fires onBlur when focus leaves the fieldset entirely', () => {
    const onBlur = vi.fn();
    render(
      <>
        <RadioGroup
          legend="Tracking"
          options={options}
          value="tracked"
          onChange={() => {}}
          onBlur={onBlur}
        />
        <button type="button">Elsewhere</button>
      </>,
    );

    const [first] = screen.getAllByRole('radio');
    fireEvent.focusOut(first, { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) });

    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});
