import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import Field from './Field';
import Input from './Input';
import PasswordInput from './PasswordInput';
import SearchInput from './SearchInput';
import Select from './Select';
import Textarea from './Textarea';

const describedFieldProps = {
  label: 'Name',
  hint: 'Shown on invoices',
  error: 'Name is required',
  'aria-describedby': 'caller-note',
  value: '',
  onChange: () => {},
};

const fieldConsumers: [string, () => ReactElement][] = [
  ['Input', () => <Input {...describedFieldProps} />],
  ['Select', () => <Select {...describedFieldProps} options={[{ value: '', label: 'None' }]} />],
  ['Textarea', () => <Textarea {...describedFieldProps} />],
  ['SearchInput', () => <SearchInput {...describedFieldProps} />],
  ['PasswordInput', () => <PasswordInput {...describedFieldProps} />],
];

describe('Field', () => {
  it('links the label to the input via htmlFor/id, so getByLabelText resolves it', () => {
    render(<Field label="Title">{(inputProps) => <input type="text" {...inputProps} />}</Field>);

    expect(screen.getByLabelText('Title')).toBeInTheDocument();
  });

  it('has no aria-describedby when there is no hint and no error', () => {
    render(<Field label="Title">{(inputProps) => <input type="text" {...inputProps} />}</Field>);

    expect(screen.getByLabelText('Title')).not.toHaveAttribute('aria-describedby');
  });

  it('sets aria-invalid and describes the input via the error text, without role=alert', () => {
    render(
      <Field label="Name" error="Name is required">
        {(inputProps) => <input type="text" {...inputProps} />}
      </Field>,
    );

    const input = screen.getByLabelText('Name');
    const errorEl = screen.getByText('Name is required', { exact: false });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input.getAttribute('aria-describedby')).toContain(errorEl.id);
  });

  it('prefixes the error text with a visually-hidden "Error: "', () => {
    render(
      <Field label="Name" error="Name is required">
        {(inputProps) => <input type="text" {...inputProps} />}
      </Field>,
    );

    expect(screen.getByText('Error:')).toBeInTheDocument();
  });

  it('describes the input with both hint and error ids when both are present', () => {
    render(
      <Field label="Name" hint="Shown on invoices" error="Name is required">
        {(inputProps) => <input type="text" {...inputProps} />}
      </Field>,
    );

    const input = screen.getByLabelText('Name');
    const errorEl = screen.getByText('Name is required', { exact: false });
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toContain(screen.getByText('Shown on invoices').id);
    expect(describedBy).toContain(errorEl.id);
  });

  it('uses a caller-supplied id for the label, the input, and the derived hint/error ids', () => {
    render(
      <Field id="custom-id" label="Name" hint="A hint" error="An error">
        {(inputProps) => <input type="text" {...inputProps} />}
      </Field>,
    );

    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('id', 'custom-id');
    expect(screen.getByText('A hint').id).toBe('custom-id-hint');
    expect(screen.getByText('An error', { exact: false }).id).toBe('custom-id-error');
  });

  it('renders the label with an "(optional)" suffix as part of its accessible name', () => {
    render(
      <Field label="Reason" optional>
        {(inputProps) => <input type="text" {...inputProps} />}
      </Field>,
    );

    // getByRole computes the accessible name via the ARIA accname algorithm, unlike
    // getByLabelText's plain textContent match — the one that actually catches the space
    // between the label text and an adjacent inline element getting trimmed away.
    expect(screen.getByRole('textbox', { name: 'Reason (optional)' })).toBeInTheDocument();
  });

  it('applies the width modifier to the wrapper', () => {
    render(
      <Field label="Title" width="sm">
        {(inputProps) => <input type="text" {...inputProps} />}
      </Field>,
    );

    expect(screen.getByLabelText('Title').closest('.field')).toHaveClass('field--sm');
  });

  it('applies the grow modifier to the wrapper', () => {
    render(
      <Field label="Title" width="grow">
        {(inputProps) => <input type="text" {...inputProps} />}
      </Field>,
    );

    expect(screen.getByLabelText('Title').closest('.field')).toHaveClass('field', 'field--grow');
  });

  it('gives the label an id derived from the field id', () => {
    render(
      <Field id="custom-id" label="Title">
        {(inputProps) => <input type="text" {...inputProps} />}
      </Field>,
    );

    expect(screen.getByText('Title')).toHaveAttribute('id', 'custom-id-label');
  });

  it.each(fieldConsumers)(
    '%s merges a caller aria-describedby between the hint and error ids',
    (_name, renderConsumer) => {
      render(renderConsumer());

      const control = screen.getByLabelText('Name');
      const hintId = screen.getByText('Shown on invoices').id;
      const errorId = screen.getByText('Name is required', { exact: false }).id;
      expect(control.getAttribute('aria-describedby')?.split(' ')).toEqual([
        hintId,
        'caller-note',
        errorId,
      ]);
    },
  );

  it('renders no width modifier at the default', () => {
    render(<Field label="Title">{(inputProps) => <input type="text" {...inputProps} />}</Field>);

    const wrapper = screen.getByLabelText('Title').closest('.field');
    expect(wrapper).toHaveClass('field');
    expect(wrapper?.className).toBe('field');
  });
});
