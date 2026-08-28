import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('metric labels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('fetches the ontology once and maps a known id to its label', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([{ id: 'cap_rate', label: 'Cap rate', canonicalUnit: 'percent' }]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { metricLabel, useMetricLabels } = await import('./metric-labels');

    const { result } = renderHook(() => useMetricLabels());

    await waitFor(() => {
      expect(metricLabel('cap_rate', result.current)).toBe('Cap rate');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls through to the raw id for a metric the ontology does not know — never blank, never "unknown"', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([{ id: 'cap_rate', label: 'Cap rate', canonicalUnit: 'percent' }]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { metricLabel, useMetricLabels } = await import('./metric-labels');

    const { result } = renderHook(() => useMetricLabels());

    await waitFor(() => {
      expect(metricLabel('cap_rate', result.current)).toBe('Cap rate');
    });
    expect(metricLabel('noi_growth', result.current)).toBe('noi_growth');
  });

  it('resolves to an empty map on a failed fetch, so every id still falls back to itself', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));
    const { metricLabel, useMetricLabels } = await import('./metric-labels');

    const { result } = renderHook(() => useMetricLabels());

    await waitFor(() => {
      expect(result.current).toEqual({});
    });
    expect(metricLabel('cap_rate', result.current)).toBe('cap_rate');
  });

  it('shares one cached fetch across multiple hook instances', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([{ id: 'cap_rate', label: 'Cap rate', canonicalUnit: 'percent' }]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { useMetricLabels } = await import('./metric-labels');

    const first = renderHook(() => useMetricLabels());
    await waitFor(() => {
      expect(first.result.current).toEqual({ cap_rate: 'Cap rate' });
    });

    const second = renderHook(() => useMetricLabels());
    await waitFor(() => {
      expect(second.result.current).toEqual({ cap_rate: 'Cap rate' });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
