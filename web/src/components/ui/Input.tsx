import type { InputHTMLAttributes } from 'react';
import Field from './Field';

interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'width'
> {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  width?: 'sm' | 'md' | 'lg' | 'grow' | 'full';
  value: string;
  onChange: (value: string) => void;
}

/** Labelled `<input>`, composed on `Field` for the label/hint/error/`aria-describedby`
 * plumbing shared with every other labelled control. Rest props (`type`, `disabled`,
 * `placeholder`, `onBlur`, …) pass through to the underlying `<input>`. `id`, when supplied,
 * flows through `Field` rather than the rest spread, so it reaches both the `<label htmlFor>`
 * and the input itself instead of being overwritten by Field's generated id. A caller `aria-describedby`
 * also flows through `Field`, which merges it with the hint and error ids. `optional` marks
 * the minority case in a form, rendering its suffix inside the label so the accessible name
 * reads "Label (optional)". `width`, though `@types/react` declares it on
 * `InputHTMLAttributes`, is forwarded to `Field` only — never spread onto the DOM node. */
export default function Input({
  id,
  label,
  hint,
  error,
  optional,
  width,
  value,
  onChange,
  'aria-describedby': describedBy,
  ...rest
}: InputProps) {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      describedBy={describedBy}
      optional={optional}
      width={width}
    >
      {(inputProps) => (
        <input {...rest} {...inputProps} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}
