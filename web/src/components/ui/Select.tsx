import type { SelectHTMLAttributes } from 'react';
import Field from './Field';

// `className` is omitted, not merged: the control sets its own `.select` class after the rest
// spread, so a caller-passed one would be dropped without any error. Omitting it makes that a
// compile failure instead of a silently ignored prop.
interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'value' | 'onChange' | 'className'
> {
  label: string;
  hint?: string;
  error?: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}

/** Labelled native `<select>`, composed on `Field` for the label/hint/error/`aria-describedby`
 * plumbing shared with every other labelled control — keyboard and role behaviour come from the
 * platform, not a hand-rolled listbox. Rest props (`disabled`, `name`, `required`, …) pass through
 * to the underlying `<select>`. */
export default function Select({
  label,
  hint,
  error,
  options,
  value,
  onChange,
  ...rest
}: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(inputProps) => (
        <select
          {...rest}
          {...inputProps}
          className="select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
