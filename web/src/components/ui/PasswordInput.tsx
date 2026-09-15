import type { InputHTMLAttributes } from 'react';
import { useState } from 'react';
import Field from './Field';

interface PasswordInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type'
> {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
}

/** `Input` for a password field, with an in-field toggle that switches the underlying `<input>`'s
 * `type` between `password` and `text`. The input is never unmounted across a toggle, so its value
 * and caret position survive it untouched. Never intercepts paste — the WCAG 3.3.8 affordance this
 * component supports exists precisely so a pasted password is never silently blocked. */
export default function PasswordInput({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  'aria-describedby': describedBy,
  ...rest
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <Field id={id} label={label} hint={hint} error={error} describedBy={describedBy}>
      {(inputProps) => (
        <div className="password-input">
          <input
            {...rest}
            {...inputProps}
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <button
            type="button"
            className="password-input-toggle"
            aria-controls={inputProps.id}
            onClick={() => setVisible((was) => !was)}
          >
            {visible ? 'Hide password' : 'Show password'}
          </button>
        </div>
      )}
    </Field>
  );
}
