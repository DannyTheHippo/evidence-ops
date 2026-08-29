import type { MouseEvent, Ref } from 'react';

export interface ErrorSummaryEntry {
  id: string;
  message: string;
}

interface ErrorSummaryProps {
  errors: ErrorSummaryEntry[];
  /** A failure with no field to attach to — see `useFormSubmit`'s `formError`. */
  formError?: string;
  heading?: string;
  /** Lets `useFormSubmit` move focus here on a failed submit — see its `summary` return value. */
  ref?: Ref<HTMLDivElement>;
}

/** The block a failed submit moves focus to, in place of a `role="alert"`: focus itself is the
 * announcement, and an alert role here would announce the same failure a second time — the same
 * reasoning that keeps `Field`'s inline error unannounced. Each entry links to its field's `id`;
 * activating it moves focus there directly rather than relying on the browser's own
 * fragment-focus behaviour, which not every browser (and no jsdom) triggers reliably. Renders
 * nothing when there is neither a field error nor a `formError`. */
export default function ErrorSummary({
  errors,
  formError,
  heading = 'There is a problem',
  ref,
}: ErrorSummaryProps) {
  if (errors.length === 0 && !formError) return null;

  function focusField(event: MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault();
    document.getElementById(id)?.focus();
  }

  return (
    <div ref={ref} tabIndex={-1} className="error-summary">
      <h2 className="error-summary-title">{heading}</h2>
      {formError && <p className="error-summary-message">{formError}</p>}
      {errors.length > 0 && (
        <ul className="error-summary-list">
          {errors.map((error) => (
            <li key={error.id}>
              <a href={`#${error.id}`} onClick={(event) => focusField(event, error.id)}>
                {error.message}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
