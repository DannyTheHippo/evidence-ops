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

  it('describes the group via aria-describedby and aria-invalid when it carries an error', () => {
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
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(group.getAttribute('aria-describedby')).toBe(errorEl.id);
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
