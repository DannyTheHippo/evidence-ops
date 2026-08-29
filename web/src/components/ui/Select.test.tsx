import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Select from './Select';

const OPTIONS = [
  { value: 'all', label: 'All types' },
  { value: 'document', label: 'Document' },
  { value: 'fact', label: 'Fact' },
];

describe('Select', () => {
  it('links the label to the select via htmlFor/id, so getByLabelText resolves it', () => {
    render(<Select label="Entity type" options={OPTIONS} value="all" onChange={() => {}} />);

    expect(screen.getByLabelText('Entity type')).toBeInTheDocument();
  });

  it('calls onChange with the newly selected value', () => {
    const onChange = vi.fn();
    render(<Select label="Entity type" options={OPTIONS} value="all" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Entity type'), { target: { value: 'fact' } });

    expect(onChange).toHaveBeenCalledWith('fact');
  });

  it('sets aria-invalid and describes the select with the error text', () => {
    render(
      <Select
        label="Entity type"
        options={OPTIONS}
        value="all"
        onChange={() => {}}
        error="Select an entity type"
      />,
    );

    expect(screen.getByLabelText('Entity type')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Select an entity type', { exact: false })).toBeInTheDocument();
  });

  it('passes rest props through to the underlying select', () => {
    render(
      <Select label="Entity type" options={OPTIONS} value="all" onChange={() => {}} disabled />,
    );

    expect(screen.getByLabelText('Entity type')).toBeDisabled();
  });

  it('uses a caller-supplied id for both the label and the select', () => {
    render(
      <Select
        id="custom-id"
        label="Entity type"
        options={OPTIONS}
        value="all"
        onChange={() => {}}
      />,
    );

    expect(screen.getByLabelText('Entity type')).toHaveAttribute('id', 'custom-id');
  });

  it('forwards onBlur to the underlying select', () => {
    const onBlur = vi.fn();
    render(
      <Select
        label="Entity type"
        options={OPTIONS}
        value="all"
        onChange={() => {}}
        onBlur={onBlur}
      />,
    );

    fireEvent.blur(screen.getByLabelText('Entity type'));

    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});
