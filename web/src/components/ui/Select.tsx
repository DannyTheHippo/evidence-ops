import type { SelectHTMLAttributes } from 'react';
import Field from './Field';

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  width?: 'sm' | 'md' | 'lg' | 'full';
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}

/** Labelled native `<select>`, composed on `Field` for the label/hint/error/`aria-describedby`
 * plumbing shared with every other labelled control — keyboard and role behaviour come from the
 * platform, not a hand-rolled listbox. Rest props (`disabled`, `name`, `required`, `onBlur`, …)
 * pass through to the underlying `<select>`. `id`, when supplied, flows through `Field` rather
 * than the rest spread, so it reaches both the `<label htmlFor>` and the select itself instead
 * of being overwritten by Field's generated id. A caller `aria-describedby` also flows through
 * `Field`, which merges it with the hint and error ids. `optional` marks the minority case in a form,
 * rendering its suffix inside the label so the accessible name reads "Label (optional)".
 * `width`, though `@types/react` does not declare it on `SelectHTMLAttributes`, is forwarded to
 * `Field` only — never spread onto the DOM node. A caller-passed `className` is merged after the
 * control's own `.select` class rather than overwriting it. */
export default function Select({
  id,
  label,
  hint,
  error,
  optional,
  width,
  options,
  value,
  onChange,
  className,
  'aria-describedby': describedBy,
  ...rest
}: SelectProps) {
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
        <select
          {...rest}
          {...inputProps}
          className={className ? `select ${className}` : 'select'}
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
