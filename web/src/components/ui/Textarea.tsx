import type { TextareaHTMLAttributes } from 'react';
import Field from './Field';

interface TextareaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange'
> {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  width?: 'sm' | 'md' | 'lg' | 'full';
  value: string;
  onChange: (value: string) => void;
}

/** Labelled `<textarea>`, composed on `Field` for the label/hint/error/`aria-describedby`
 * plumbing shared with every other labelled control. Rest props (`disabled`, `placeholder`,
 * `rows`, `onBlur`, …) pass through to the underlying `<textarea>`. `id`, when supplied, flows
 * through `Field` rather than the rest spread, so it reaches both the `<label htmlFor>` and the
 * textarea itself instead of being overwritten by Field's generated id. A caller
 * `aria-describedby` also flows through `Field`, which merges it with the hint and error ids.
 * `optional` marks the
 * minority case in a form, rendering its suffix inside the label so the accessible name reads
 * "Label (optional)". `width` is forwarded to `Field` only, never spread onto the DOM node. */
export default function Textarea({
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
}: TextareaProps) {
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
        <textarea
          {...rest}
          {...inputProps}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}
