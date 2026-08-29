import { useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { ApiError, isFieldValidationError, type FieldError } from '../api/client';

/**
 * Options for {@link useFormSubmit}. `F` is the set of DTO property names the form can show a
 * field-level error for — not the caller's local state variable names, which is what lets a
 * server field path be matched against a control by name.
 */
export interface UseFormSubmitOptions<F extends string> {
  /** Pure client-side check over the caller's own state; returns one message per invalid field.
   * Runs on every blur and at the start of every submit attempt, never on change. */
  validate?: () => Partial<Record<F, string>>;
  /** The request this form performs. Rejects with the `ApiError` `web/src/api/client.ts` throws
   * for every failure — transport, validation, and domain alike. */
  submit: () => Promise<void>;
  /** Runs once `submit` resolves and errors have been cleared. */
  onSuccess?: () => void;
  /** Maps a domain `ApiError` (one that is not a field-validation error) onto specific fields. A
   * `null` result leaves the error to render as `formError` instead. */
  mapServerError?: (err: ApiError) => Partial<Record<F, string>> | null;
}

export interface UseFormSubmitResult<F extends string> {
  /** True from the moment `submit` is called until it settles. Never true while only client
   * validation is being checked, since no request is in flight then. */
  pending: boolean;
  /** A failure with no field to attach to: a transport error, a domain error `mapServerError`
   * declined, or a field-validation error naming a field the form has no control for. */
  formError: string | null;
  /** Client and server field errors merged, client winning where both name the same field. Not
   * filtered by visibility — see `fieldProps` and `summary` for what actually renders. */
  errors: Partial<Record<F, string>>;
  /** Synchronous submit handler: calls `preventDefault` and fires the async work without
   * returning a promise, so a call site never needs its own `void handleSubmit(e)` wrapper. */
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  /** Wires one field into the form: a stable `id`, `error` visible only once the field has been
   * blurred or a submit attempted, and the `onBlur` that runs validation. */
  fieldProps: (name: F) => { id: string; error?: string; onBlur: () => void };
  /** `ref` for an optional error summary container. Attaching it changes focus behaviour on a
   * failed submit — see {@link useFormSubmit}. `errors` lists only the currently visible field
   * errors, in the order the form declared its fields. */
  summary: { ref: RefObject<HTMLDivElement | null>; errors: { id: string; message: string }[] };
}

/**
 * Owns a form's validation timing, submission lifecycle, and error presentation so a page never
 * hand-rolls any of the three.
 *
 * Validation is hybrid: a field's error is computed by `validate` but stays hidden until that
 * field has been blurred or a submit has been attempted, so a fresh form never opens with a wall
 * of red text. A ref (not state) tracks which fields have been touched, since touching a field is
 * not itself a rendering event — the blur handler's own `validate` re-run is what triggers the
 * render that reveals it.
 *
 * A submit attempt that fails client validation never calls `submit`. One that reaches `submit`
 * and fails maps the error onto `errors`/`formError` in a fixed order: a field-validation error's
 * `fields` first, `mapServerError` second, a plain `formError` last. A field-validation entry
 * whose name (its root segment, before any `.`) has no registered control folds into `formError`
 * instead of being dropped — the API dot-joins nested and indexed paths, so a path like
 * `aliases.0` matches a control registered for `aliases`.
 *
 * Focus moves on the next animation frame after any failed submit: to the summary if a caller
 * attached one (focus is the announcement, so the summary itself needs no `role="alert"`), else to
 * the first invalid control. A `formError`-only failure with no summary attached moves focus
 * nowhere, since there is no control to send it to — the caller renders `formError` into its own
 * inline alert.
 */
export function useFormSubmit<F extends string>(
  opts: UseFormSubmitOptions<F>,
): UseFormSubmitResult<F> {
  const { validate, submit, onSuccess, mapServerError } = opts;

  const [clientErrors, setClientErrors] = useState<Partial<Record<F, string>>>({});
  const [serverErrors, setServerErrors] = useState<Partial<Record<F, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const baseId = useId();
  const touchedRef = useRef<Set<F>>(new Set());
  const submittedRef = useRef(false);
  // Holds between the click and the re-render that disables the submit button, which `disabled`
  // alone cannot do — the guard is checked and set synchronously in `onSubmit`, before any await.
  const inFlightRef = useRef(false);
  // Insertion order doubles as declaration order: `fieldProps` pushes a name the first time it is
  // called, and a render calls it once per field in the order the form's JSX declares them.
  const fieldOrderRef = useRef<F[]>([]);
  const summaryRef = useRef<HTMLDivElement>(null);

  const errors: Partial<Record<F, string>> = { ...serverErrors, ...clientErrors };

  function fieldId(name: F): string {
    return `${baseId}-${name}`;
  }

  function isVisible(name: F): boolean {
    return submittedRef.current || touchedRef.current.has(name);
  }

  function registerField(name: F): void {
    if (!fieldOrderRef.current.includes(name)) {
      fieldOrderRef.current.push(name);
    }
  }

  function handleBlur(name: F): void {
    touchedRef.current.add(name);
    if (validate) setClientErrors(validate());
  }

  function scheduleFocus(fieldErrors: Partial<Record<F, string>>, topError: string | null): void {
    requestAnimationFrame(() => {
      if (summaryRef.current) {
        summaryRef.current.focus();
        return;
      }
      if (topError) return;
      const firstInvalid = fieldOrderRef.current.find((name) => fieldErrors[name] !== undefined);
      if (!firstInvalid) return;
      document.getElementById(fieldId(firstInvalid))?.focus();
    });
  }

  // A field-validation entry's field name is a DTO property path, matched on its root segment
  // against the names the form has actually registered a control for. A root with no control —
  // the upload form's multipart `file` part, or a `decision`/`winningFactId` with no field at all
  // — folds into the summary message rather than vanishing silently.
  function foldFieldErrors(fields: readonly FieldError[]): {
    fieldErrors: Partial<Record<F, string>>;
    unmatched: string[];
  } {
    const known = new Set(fieldOrderRef.current);
    const fieldErrors: Partial<Record<F, string>> = {};
    const unmatched: string[] = [];
    for (const { field, message } of fields) {
      const root = field.split('.')[0] as F;
      if (known.has(root)) {
        fieldErrors[root] = message;
      } else {
        unmatched.push(message);
      }
    }
    return { fieldErrors, unmatched };
  }

  function resolveSubmitError(err: unknown): {
    fieldErrors: Partial<Record<F, string>>;
    topError: string | null;
  } {
    if (isFieldValidationError(err)) {
      const { fieldErrors, unmatched } = foldFieldErrors(err.fields);
      return { fieldErrors, topError: unmatched.length > 0 ? unmatched.join('; ') : null };
    }
    if (err instanceof ApiError) {
      if (mapServerError) {
        const mapped = mapServerError(err);
        if (mapped) return { fieldErrors: mapped, topError: null };
      }
      return { fieldErrors: {}, topError: err.message };
    }
    return {
      fieldErrors: {},
      topError: err instanceof Error ? err.message : 'Something went wrong.',
    };
  }

  async function runSubmit(): Promise<void> {
    submittedRef.current = true;
    const freshClientErrors = validate ? validate() : {};
    setClientErrors(freshClientErrors);
    setServerErrors({});
    setFormError(null);

    if (Object.keys(freshClientErrors).length > 0) {
      scheduleFocus(freshClientErrors, null);
      inFlightRef.current = false;
      return;
    }

    setPending(true);
    try {
      await submit();
      setClientErrors({});
      setServerErrors({});
      setFormError(null);
      onSuccess?.();
    } catch (err) {
      const { fieldErrors, topError } = resolveSubmitError(err);
      setServerErrors(fieldErrors);
      setFormError(topError);
      scheduleFocus(fieldErrors, topError);
    } finally {
      setPending(false);
      inFlightRef.current = false;
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    void runSubmit();
  }

  function fieldProps(name: F): { id: string; error?: string; onBlur: () => void } {
    registerField(name);
    return {
      id: fieldId(name),
      error: isVisible(name) ? errors[name] : undefined,
      onBlur: () => handleBlur(name),
    };
  }

  function collectSummaryErrors(): { id: string; message: string }[] {
    return fieldOrderRef.current
      .filter((name) => isVisible(name) && errors[name] !== undefined)
      .map((name) => ({ id: fieldId(name), message: errors[name] as string }));
  }

  return {
    pending,
    formError,
    errors,
    onSubmit,
    fieldProps,
    // fieldOrderRef is a ref by design — registering a field's declaration order must never itself
    // force a render — and every value that can change visible summary content already goes
    // through the errors/pending state above, so reading the order here on each render reflects
    // that state correctly rather than lagging behind it.
    // eslint-disable-next-line react-hooks/refs -- see comment above
    summary: { ref: summaryRef, errors: collectSummaryErrors() },
  };
}
