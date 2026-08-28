import type { InputHTMLAttributes } from 'react';
import Field from './Field';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
}

/** Labelled `<input>`, composed on `Field` for the label/hint/error/`aria-describedby`
 * plumbing shared with every other labelled control. Rest props (`type`, `disabled`,
 * `placeholder`, …) pass through to the underlying `<input>`. */
export default function Input({ label, hint, error, value, onChange, ...rest }: InputProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(inputProps) => (
        <input {...rest} {...inputProps} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}
