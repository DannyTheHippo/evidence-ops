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

  it('sets aria-invalid and exposes the error via role=alert', () => {
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
    expect(screen.getByRole('alert')).toHaveTextContent('Select an entity type');
  });

  it('passes rest props through to the underlying select', () => {
    render(
      <Select label="Entity type" options={OPTIONS} value="all" onChange={() => {}} disabled />,
    );

    expect(screen.getByLabelText('Entity type')).toBeDisabled();
  });
});
