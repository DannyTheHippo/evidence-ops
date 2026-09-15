import { useId, type ReactElement } from 'react';

interface FieldProps {
  /** Overrides the internally generated id for the `<label htmlFor>`, the render prop's `id`, and
   * the derived label/hint/error ids (`${id}-label`, `${id}-hint`, `${id}-error`). Lets a caller
   * that owns its own id scheme (an error summary wiring up focus targets) keep the field's DOM id
   * in sync with it. */
  id?: string;
  label: string;
  hint?: string;
  error?: string;
  /** Space-separated ids of further describing elements the caller owns. They join the
   * control's `aria-describedby` between the hint id and the error id, so a caller's description
   * survives alongside the field's own hint and error text. */
  describedBy?: string;
  /** Appends an "(optional)" suffix inside the `<label>` itself, so it stays part of the
   * control's accessible name rather than sitting beside it unannounced. */
  optional?: boolean;
  /** Sizes the wrapper via a `field--{width}` modifier class; defaults to `'full'`, which adds
   * none. */
  width?: 'sm' | 'md' | 'lg' | 'grow' | 'full';
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
export default function Field({
  id: idProp,
  label,
  hint,
  error,
  describedBy,
  optional,
  width = 'full',
  children,
}: FieldProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const ariaDescribedBy =
    [hint ? hintId : null, describedBy, error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className={width === 'full' ? 'field' : `field field--${width}`}>
      <label id={`${id}-label`} htmlFor={id} className="field-label">
        {label}
        {optional && (
          <>
            {' '}
            <span className="field-optional">(optional)</span>
          </>
        )}
      </label>
      {children({
        id,
        'aria-describedby': ariaDescribedBy,
        'aria-invalid': error ? true : undefined,
      })}
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
