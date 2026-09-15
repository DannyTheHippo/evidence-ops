import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Combobox from './Combobox';

const OPTIONS = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta' },
  { value: 'gamma', label: 'Gamma' },
];

// jsdom's native `.focus()` moves `document.activeElement` but does not itself dispatch the
// bubbling `focusin` React 19 listens for, so the two calls are both needed to move real focus
// and to run the component's `onFocus` handler.
function focusInput(input: HTMLElement) {
  input.focus();
  fireEvent.focus(input);
}

describe('Combobox', () => {
  it('links the label to the input via htmlFor/id, so getByLabelText resolves it', () => {
    render(<Combobox label="Entity" options={OPTIONS} value="" onChange={() => {}} />);

    expect(screen.getByLabelText('Entity')).toBeInTheDocument();
  });

  it('exposes role=combobox with aria-expanded and aria-controls tied to the listbox', () => {
    render(<Combobox label="Entity" options={OPTIONS} value="" onChange={() => {}} />);

    const input = screen.getByRole('combobox', { name: 'Entity' });
    expect(input).toHaveAttribute('aria-expanded', 'false');

    focusInput(input);

    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
  });

  it('filters options by the typed text', () => {
    render(<Combobox label="Entity" options={OPTIONS} value="" onChange={() => {}} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Entity' }), {
      target: { value: 'be' },
    });

    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('Beta');
  });

  it('moves the active option with the arrow keys', () => {
    render(<Combobox label="Entity" options={OPTIONS} value="" onChange={() => {}} />);

    const input = screen.getByRole('combobox', { name: 'Entity' });
    focusInput(input);
    const options = screen.getAllByRole('option');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
  });

  it('commits the active option on Enter', () => {
    const onChange = vi.fn();
    render(<Combobox label="Entity" options={OPTIONS} value="" onChange={onChange} />);

    const input = screen.getByRole('combobox', { name: 'Entity' });
    focusInput(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('beta');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes on Escape and keeps focus in the input', () => {
    render(<Combobox label="Entity" options={OPTIONS} value="" onChange={() => {}} />);

    const input = screen.getByRole('combobox', { name: 'Entity' });
    focusInput(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('removes a chip by its named control', () => {
    const onValuesChange = vi.fn();
    render(
      <Combobox
        label="Entities"
        options={OPTIONS}
        values={['alpha', 'beta']}
        onValuesChange={onValuesChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Alpha' }));

    expect(onValuesChange).toHaveBeenCalledWith(['beta']);
  });

  it('forwards width to the field wrapper, not the input element', () => {
    render(<Combobox label="Entity" options={OPTIONS} value="" onChange={() => {}} width="sm" />);

    const input = screen.getByRole('combobox', { name: 'Entity' });
    expect(input.closest('.field')).toHaveClass('field--sm');
    expect(input).not.toHaveAttribute('width');
  });
});
