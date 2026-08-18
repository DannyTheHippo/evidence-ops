import { useId, type ReactElement } from 'react';

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: (inputProps: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
  }) => ReactElement;
}

/** Labelled form field wrapper: a real `<label htmlFor>` linked to the input the caller renders
 * via the render prop, plus hint and error text wired through `aria-describedby`. `error` also
 * drives `aria-invalid` and renders inside `role="alert"`, matching the `role="alert"` error
 * paragraphs already used across the app. */
export default function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
