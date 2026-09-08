import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Measure } from '../../api/client';
import MeasureEditorDialog from './MeasureEditorDialog';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const measure: Measure = {
  id: 'measure-1',
  slug: 'cap_rate',
  label: 'Cap Rate',
  aliases: ['Capitalization Rate', 'Cap rate %'],
  valueType: 'percentage',
  canonicalUnit: 'ratio',
  units: [
    { id: 'ratio', toCanonicalFactor: 1 },
    { id: 'percent', toCanonicalFactor: 0.01 },
  ],
  toleranceKind: 'absolute',
  tolerance: 0.0025,
  stalenessWindowMs: 15552000000,
  status: 'proposed',
  origin: 'header',
  proposedFrom: [],
  version: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
};

describe('MeasureEditorDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('prefills every field from the measure, titled and labelled for confirm mode', () => {
    render(
      <MeasureEditorDialog
        measure={measure}
        mode="confirm"
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Confirm "Cap Rate"' })).toBeInTheDocument();
    expect(screen.getByLabelText('Label')).toHaveValue('Cap Rate');
    expect(screen.getByLabelText('Aliases (optional)')).toHaveValue(
      'Capitalization Rate\nCap rate %',
    );
    expect(screen.getByLabelText('Value type')).toHaveValue('percentage');
    expect(screen.getByLabelText('Canonical unit')).toHaveValue('ratio');
    expect(screen.getByLabelText('Tolerance kind')).toHaveValue('absolute');
    expect(screen.getByLabelText('Tolerance')).toHaveValue(0.0025);
    expect(screen.getByLabelText('Staleness window (ms) (optional)')).toHaveValue(15552000000);
    expect(screen.getByRole('button', { name: 'Confirm measure' })).toBeInTheDocument();
  });

  it('titles and labels the dialog for edit mode', () => {
    render(
      <MeasureEditorDialog measure={measure} mode="edit" onClose={() => {}} onSaved={() => {}} />,
    );

    expect(screen.getByRole('dialog', { name: 'Edit "Cap Rate"' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('focuses the error summary and lists the error when Label is cleared', async () => {
    render(
      <MeasureEditorDialog
        measure={measure}
        mode="confirm"
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm measure' }));

    await waitFor(() => {
      const summary = screen.getByRole('heading', { name: 'There is a problem' }).parentElement;
      expect(summary).toHaveFocus();
    });
    expect(screen.getByRole('link', { name: 'Label is required.' })).toBeInTheDocument();
    expect(screen.getByText('Label is required.', { selector: 'p' })).toBeInTheDocument();
  });

  it('confirms with the edited body and calls onSaved with the response row', async () => {
    const confirmed: Measure = {
      ...measure,
      label: 'Capitalization Rate',
      status: 'confirmed',
      version: 2,
    };
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(confirmed)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    render(
      <MeasureEditorDialog measure={measure} mode="confirm" onClose={() => {}} onSaved={onSaved} />,
    );

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Capitalization Rate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm measure' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(confirmed));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/measures/measure-1/confirm');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      label: 'Capitalization Rate',
      aliases: ['Capitalization Rate', 'Cap rate %'],
      valueType: 'percentage',
      canonicalUnit: 'ratio',
      toleranceKind: 'absolute',
      tolerance: 0.0025,
      stalenessWindowMs: 15552000000,
    });
  });

  it('saves an edit via PATCH against the measure id', async () => {
    const updated: Measure = { ...measure, version: 2 };
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(updated)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    render(
      <MeasureEditorDialog measure={measure} mode="edit" onClose={() => {}} onSaved={onSaved} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/measures/measure-1');
    expect(init.method).toBe('PATCH');
  });

  it('lands a tolerance field-validation error on the Tolerance field, not the form banner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            {
              message: 'Validation failed',
              errors: [{ field: 'tolerance', message: 'tolerance must not be less than 0' }],
            },
            400,
          ),
        ),
      ),
    );
    const onSaved = vi.fn();

    render(
      <MeasureEditorDialog measure={measure} mode="confirm" onClose={() => {}} onSaved={onSaved} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm measure' }));

    expect(
      await screen.findByText('tolerance must not be less than 0', { selector: 'p' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('calls onClose from the cancel action', () => {
    const onClose = vi.fn();
    render(
      <MeasureEditorDialog measure={measure} mode="confirm" onClose={onClose} onSaved={() => {}} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
