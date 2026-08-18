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

  it('sets aria-invalid and exposes the error via role=alert', () => {
    render(
      <Field label="Name" error="Name is required">
        {(inputProps) => <input type="text" {...inputProps} />}
      </Field>,
    );

    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
    expect(input.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
  });

  it('describes the input with both hint and error ids when both are present', () => {
    render(
      <Field label="Name" hint="Shown on invoices" error="Name is required">
        {(inputProps) => <input type="text" {...inputProps} />}
      </Field>,
    );

    const input = screen.getByLabelText('Name');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toContain(screen.getByText('Shown on invoices').id);
    expect(describedBy).toContain(screen.getByRole('alert').id);
  });
});
