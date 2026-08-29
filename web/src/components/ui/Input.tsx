import type { InputHTMLAttributes } from 'react';
import Field from './Field';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  value: string;
  onChange: (value: string) => void;
}

/** Labelled `<input>`, composed on `Field` for the label/hint/error/`aria-describedby`
 * plumbing shared with every other labelled control. Rest props (`type`, `disabled`,
 * `placeholder`, `onBlur`, …) pass through to the underlying `<input>`. `id`, when supplied,
 * flows through `Field` rather than the rest spread, so it reaches both the `<label htmlFor>`
 * and the input itself instead of being overwritten by Field's generated id. `optional` marks
 * the minority case in a form, rendering its suffix inside the label so the accessible name
 * reads "Label (optional)". */
export default function Input({
  id,
  label,
  hint,
  error,
  optional,
  value,
  onChange,
  ...rest
}: InputProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} optional={optional}>
      {(inputProps) => (
        <input {...rest} {...inputProps} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}
