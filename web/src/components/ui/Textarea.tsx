import type { TextareaHTMLAttributes } from 'react';
import Field from './Field';

interface TextareaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange'
> {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
}

/** Labelled `<textarea>`, composed on `Field` for the label/hint/error/`aria-describedby`
 * plumbing shared with every other labelled control. Rest props (`disabled`, `placeholder`,
 * `rows`, …) pass through to the underlying `<textarea>`. */
export default function Textarea({ label, hint, error, value, onChange, ...rest }: TextareaProps) {
  return (
    <Field label={label} hint={hint} error={error}>
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
