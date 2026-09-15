import type { FocusEvent } from 'react';
import { useId } from 'react';

export interface RadioOption {
  value: string;
  label: string;
  hint?: string;
}

interface RadioGroupProps {
  legend: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  /** Overrides the internally generated id. Placed on the first radio rather than the `fieldset`,
   * so an `ErrorSummary` link targeting the group lands focus on something focusable. */
  id?: string;
  error?: string;
  /** Fires once focus leaves the fieldset entirely. Arrowing between radios inside it must not
   * trigger this, or the field would error while the user is still choosing. */
  onBlur?: () => void;
}

/** `fieldset`/`legend` plus native exclusive radios, for a small set of options where every value —
 * including the "off" one — is a named, permanent state rather than an unchecked default a user
 * forgot to change. `error` renders inside the fieldset, which describes the group via
 * `aria-describedby`; `aria-invalid` lands on each radio rather than the fieldset, because ARIA 1.2
 * does not support it on `role="group"`. Each option's `hint` reaches its own radio through
 * `aria-describedby`, keeping the hint out of the radio's accessible name. */
export default function RadioGroup({
  legend,
  options,
  value,
  onChange,
  id,
  error,
  onBlur,
}: RadioGroupProps) {
  const generatedId = useId();
  const groupId = id ?? generatedId;
  const errorId = `${groupId}-error`;
  const name = useId();

  function handleBlur(event: FocusEvent<HTMLFieldSetElement>) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    onBlur?.();
  }

  return (
    <fieldset
      className="radio-group"
      aria-describedby={error ? errorId : undefined}
      onBlur={handleBlur}
    >
      <legend className="radio-group-legend">{legend}</legend>
      {options.map((option, index) => {
        const hintId = option.hint ? `${groupId}-${option.value}-hint` : undefined;
        return (
          <div key={option.value} className="radio-group-option">
            <label className="radio-group-option-label">
              <input
                type="radio"
                id={index === 0 ? groupId : undefined}
                name={name}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                aria-describedby={hintId}
                aria-invalid={error ? true : undefined}
              />
              <span className="radio-group-option-text">{option.label}</span>
            </label>
            {option.hint && (
              <span id={hintId} className="field-hint">
                {option.hint}
              </span>
            )}
          </div>
        );
      })}
      {error && (
        <p id={errorId} className="field-error">
          <span className="sr-only">Error: </span>
          {error}
        </p>
      )}
    </fieldset>
  );
}
