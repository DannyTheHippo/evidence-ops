import { useId, type InputHTMLAttributes } from 'react';

interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'checked' | 'onChange' | 'type'
> {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** Native `<input type="checkbox">` with its label beside the control, not `Field`'s stacked
 * shape — for a standalone boolean filter or setting, never a table row selection. `hint` reaches
 * the control through `aria-describedby` so it stays out of the accessible name. Rest props
 * (`disabled`, `name`, …) pass through to the underlying input. */
export default function Checkbox({ id, label, hint, checked, onChange, ...rest }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;

  return (
    <span className="checkbox">
      <input
        {...rest}
        type="checkbox"
        id={inputId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hintId}
      />
      <span className="checkbox-mark" aria-hidden="true" />
      <label htmlFor={inputId}>{label}</label>
      {hint && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
    </span>
  );
}
