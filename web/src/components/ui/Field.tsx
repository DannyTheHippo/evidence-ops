import { useId, type ReactElement } from 'react';

interface FieldProps {
  /** Overrides the internally generated id for the `<label htmlFor>`, the render prop's `id`, and
   * the derived hint/error ids. Lets a caller that owns its own id scheme (an error summary
   * wiring up focus targets) keep the field's DOM id in sync with it. */
  id?: string;
  label: string;
  hint?: string;
  error?: string;
  /** Appends an "(optional)" suffix inside the `<label>` itself, so it stays part of the
   * control's accessible name rather than sitting beside it unannounced. */
  optional?: boolean;
  children: (inputProps: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
  }) => ReactElement;
}

/** Labelled form field wrapper: a real `<label htmlFor>` linked to the input the caller renders
 * via the render prop, plus hint and error text wired through `aria-describedby`. `error` also
 * drives `aria-invalid` on the input. The error text carries no `role="alert"`: announcement
 * happens by moving focus to an error summary elsewhere, and an alert role here would announce
 * the same failure twice. A visually-hidden "Error: " prefix still names the text for a screen
 * reader that lands on the field directly rather than via the summary. */
export default function Field({ id: idProp, label, hint, error, optional, children }: FieldProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
        {optional && <span className="field-optional"> (optional)</span>}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
      {error && (
        <p id={errorId} className="field-error">
          <span className="sr-only">Error: </span>
          {error}
        </p>
      )}
    </div>
  );
}
