import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Field from './Field';

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

    expect(screen.getByLabelText('Reason (optional)')).toBeInTheDocument();
  });
});
