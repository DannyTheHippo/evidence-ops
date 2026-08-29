import { act, renderHook, waitFor } from '@testing-library/react';
import type { FormEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { useFormSubmit } from './use-form-submit';

// `onSubmit` only reads `preventDefault` off the event, so a bare stub stands in for the real
// `FormEvent<HTMLFormElement>` React would supply.
function fakeEvent(): FormEvent<HTMLFormElement> {
  return { preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>;
}

// Resolves or rejects on demand, so a test can inspect `pending` mid-flight.
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Field = 'name' | 'owner';

describe('useFormSubmit', () => {
  it('shows no error before any field has been touched or submitted', () => {
    const { result } = renderHook(() =>
      useFormSubmit<Field>({
        validate: () => ({ name: 'Name is required' }),
        submit: () => Promise.resolve(),
      }),
    );

    // `validate` runs on blur and on submit, never eagerly — neither has happened yet.
    expect(result.current.fieldProps('name').error).toBeUndefined();
    expect(result.current.errors).toEqual({});
  });

  it('reveals a field error once that field is blurred', () => {
    const { result } = renderHook(() =>
      useFormSubmit<Field>({
        validate: () => ({ name: 'Name is required' }),
        submit: () => Promise.resolve(),
      }),
    );

    act(() => {
      result.current.fieldProps('name').onBlur();
    });

    expect(result.current.fieldProps('name').error).toBe('Name is required');
    // Blurring one field never reveals another that has not itself been touched or submitted.
    expect(result.current.fieldProps('owner').error).toBeUndefined();
  });

  it('reveals every field error once a submit has been attempted', () => {
    const { result } = renderHook(() =>
      useFormSubmit<Field>({
        validate: () => ({ name: 'Name is required', owner: 'Owner is required' }),
        submit: () => Promise.resolve(),
      }),
    );

    // A client-validation failure never reaches `submit`, so this settles synchronously.
    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    expect(result.current.fieldProps('name').error).toBe('Name is required');
    expect(result.current.fieldProps('owner').error).toBe('Owner is required');
  });

  it('never calls submit when client validation fails', () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useFormSubmit<Field>({ validate: () => ({ name: 'Name is required' }), submit }),
    );

    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    expect(submit).not.toHaveBeenCalled();
  });

  it('blocks a second concurrent submit while the first is still in flight', () => {
    const submit = vi.fn(() => deferred<void>().promise);
    const { result } = renderHook(() => useFormSubmit<Field>({ submit }));

    act(() => {
      result.current.onSubmit(fakeEvent());
      result.current.onSubmit(fakeEvent());
    });

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('reports pending only while submit is in flight, including after a rejection', async () => {
    const work = deferred<void>();
    const submit = vi.fn(() => work.promise);
    const { result } = renderHook(() => useFormSubmit<Field>({ submit }));

    act(() => {
      result.current.onSubmit(fakeEvent());
    });
    expect(result.current.pending).toBe(true);

    await act(async () => {
      work.reject(new Error('boom'));
      await work.promise.catch(() => undefined);
    });

    expect(result.current.pending).toBe(false);
  });

  it('maps an ApiError carrying field errors onto errors by field name', async () => {
    const submit = vi
      .fn()
      .mockRejectedValue(
        new ApiError(400, 'Validation failed', [{ field: 'name', message: 'Too short' }]),
      );
    const { result } = renderHook(() => useFormSubmit<Field>({ submit }));
    // Registers 'name' as a known control, so the server's field path matches it.
    result.current.fieldProps('name');

    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    await waitFor(() => {
      expect(result.current.errors).toEqual({ name: 'Too short' });
      expect(result.current.formError).toBeNull();
    });
  });

  it('folds a field-validation error naming an unregistered field into formError', async () => {
    const submit = vi
      .fn()
      .mockRejectedValue(
        new ApiError(400, 'Validation failed', [{ field: 'file', message: 'File is required' }]),
      );
    const { result } = renderHook(() => useFormSubmit<Field>({ submit }));
    // Registers 'name' as the only known control — 'file' has none.
    result.current.fieldProps('name');

    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    await waitFor(() => {
      expect(result.current.errors).toEqual({});
      expect(result.current.formError).toBe('File is required');
    });
  });

  it('matches an indexed or nested field path on its root segment', async () => {
    const submit = vi
      .fn()
      .mockRejectedValue(
        new ApiError(400, 'Validation failed', [{ field: 'aliases.0', message: 'Alias is blank' }]),
      );
    const { result } = renderHook(() => useFormSubmit<'aliases'>({ submit }));
    result.current.fieldProps('aliases');

    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    await waitFor(() => {
      expect(result.current.errors).toEqual({ aliases: 'Alias is blank' });
      expect(result.current.formError).toBeNull();
    });
  });

  it('merges a mapServerError mapping into errors', async () => {
    const submit = vi.fn().mockRejectedValue(new ApiError(409, 'Name already exists'));
    const { result } = renderHook(() =>
      useFormSubmit<Field>({
        submit,
        mapServerError: (err) => (err.status === 409 ? { name: err.message } : null),
      }),
    );

    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    await waitFor(() => {
      expect(result.current.errors).toEqual({ name: 'Name already exists' });
      expect(result.current.formError).toBeNull();
    });
  });

  it('falls through to formError when mapServerError returns null', async () => {
    const submit = vi.fn().mockRejectedValue(new ApiError(500, 'Internal server error'));
    const { result } = renderHook(() =>
      useFormSubmit<Field>({ submit, mapServerError: () => null }),
    );

    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    await waitFor(() => {
      expect(result.current.errors).toEqual({});
      expect(result.current.formError).toBe('Internal server error');
    });
  });

  it('turns a non-ApiError rejection into formError', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('Could not reach the server.'));
    const { result } = renderHook(() => useFormSubmit<Field>({ submit }));

    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    await waitFor(() => {
      expect(result.current.formError).toBe('Could not reach the server.');
    });
  });

  it('focuses the summary on a failed submit when a summary ref is attached', async () => {
    const submit = vi.fn().mockRejectedValue(new ApiError(500, 'Internal server error'));
    const { result } = renderHook(() => useFormSubmit<Field>({ submit }));

    const summaryEl = document.createElement('div');
    summaryEl.tabIndex = -1;
    document.body.appendChild(summaryEl);
    // `RefObject.current` is normally set by React committing `ref={summary.ref}`; assigning it
    // directly stands in for that commit in a bare `renderHook` test.
    result.current.summary.ref.current = summaryEl;

    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    // Focus moves on the next animation frame, after the rejection has already been resolved into
    // state — `waitFor` polls past both instead of racing a raw timer against them.
    await waitFor(() => {
      expect(document.activeElement).toBe(summaryEl);
    });
    summaryEl.remove();
  });

  it('focuses the first invalid control when no summary ref is attached', async () => {
    const { result } = renderHook(() =>
      useFormSubmit<Field>({
        validate: () => ({ owner: 'Owner is required' }),
        submit: () => Promise.resolve(),
      }),
    );

    const { id } = result.current.fieldProps('owner');
    const inputEl = document.createElement('input');
    inputEl.id = id;
    document.body.appendChild(inputEl);

    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(inputEl);
    });
    inputEl.remove();
  });

  it('moves focus nowhere for a formError-only failure with no summary attached', async () => {
    const submit = vi.fn().mockRejectedValue(new ApiError(500, 'Internal server error'));
    const { result } = renderHook(() => useFormSubmit<Field>({ submit }));
    document.body.focus();

    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    await waitFor(() => {
      expect(result.current.formError).toBe('Internal server error');
    });
    // No control and no summary to send focus to — give the scheduled animation frame a chance to
    // run, then assert nothing moved it off the body.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(document.activeElement).toBe(document.body);
  });

  it('calls onSuccess only once submit resolves, never on a failed attempt', async () => {
    const onSuccess = vi.fn();
    const failing = renderHook(() =>
      useFormSubmit<Field>({
        submit: () => Promise.reject(new Error('boom')),
        onSuccess,
      }),
    );
    act(() => {
      failing.result.current.onSubmit(fakeEvent());
    });
    await waitFor(() => {
      expect(failing.result.current.formError).toBe('boom');
    });
    expect(onSuccess).not.toHaveBeenCalled();

    const succeeding = renderHook(() =>
      useFormSubmit<Field>({ submit: () => Promise.resolve(), onSuccess }),
    );
    act(() => {
      succeeding.result.current.onSubmit(fakeEvent());
    });
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it('clears errors and formError once submit succeeds', async () => {
    let shouldFail = true;
    const submit = vi.fn(() =>
      shouldFail ? Promise.reject(new ApiError(500, 'Internal server error')) : Promise.resolve(),
    );
    const { result } = renderHook(() => useFormSubmit<Field>({ submit }));

    act(() => {
      result.current.onSubmit(fakeEvent());
    });
    await waitFor(() => {
      expect(result.current.formError).toBe('Internal server error');
    });

    shouldFail = false;
    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    await waitFor(() => {
      expect(result.current.formError).toBeNull();
      expect(result.current.errors).toEqual({});
    });
  });

  it('orders summary.errors by field-declaration order, not object-key order', () => {
    const { result } = renderHook(() =>
      useFormSubmit<Field>({
        validate: () => ({ owner: 'Owner is required', name: 'Name is required' }),
        submit: () => Promise.resolve(),
      }),
    );
    // Declared in this order, the reverse of the keys `validate` returns above.
    result.current.fieldProps('owner');
    result.current.fieldProps('name');

    // A client-validation failure never reaches `submit`, so this settles synchronously.
    act(() => {
      result.current.onSubmit(fakeEvent());
    });

    expect(result.current.summary.errors.map((e) => e.message)).toEqual([
      'Owner is required',
      'Name is required',
    ]);
  });
});
