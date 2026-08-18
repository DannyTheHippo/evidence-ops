import { useId } from 'react';

interface SelectProps {
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}

/** Labelled native `<select>` — keyboard and role behaviour come from the platform, not a
 * hand-rolled listbox. Shares `Field`'s labelling contract (a real `<label htmlFor>`, an
 * optional hint wired through `aria-describedby`) without pulling in `Field`'s error/render-prop
 * machinery, which this component's one bounded-option consumer does not need. */
export default function Select({ label, hint, options, value, onChange }: SelectProps) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <select
        id={id}
        className="select"
        value={value}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}
