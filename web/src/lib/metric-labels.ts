import { useEffect, useState } from 'react';
import { listMetrics } from '../api/client';

// The ontology is part of the deployed code, not per-tenant data — one fetch per browser session
// covers every page, so the label map lives here rather than behind a hook-per-mount fetch.
let cachedLabels: Record<string, string> | null = null;
let inFlightFetch: Promise<Record<string, string>> | null = null;

// A label is decoration, never load-bearing: a `/metrics` outage must not break a page that
// otherwise renders fact or conflict data fine, so a failed fetch resolves to an empty map — every
// lookup then falls through to the raw id via `metricLabel` — rather than rejecting.
function fetchMetricLabels(): Promise<Record<string, string>> {
  if (cachedLabels) return Promise.resolve(cachedLabels);
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = listMetrics()
    .then((metrics) => {
      cachedLabels = Object.fromEntries(metrics.map((metric) => [metric.id, metric.label]));
      return cachedLabels;
    })
    .catch(() => {
      cachedLabels = {};
      return cachedLabels;
    })
    .finally(() => {
      inFlightFetch = null;
    });

  return inFlightFetch;
}

/**
 * The display label for a metric id, looked up in a map built by `useMetricLabels()`. `factKey.metric`
 * is an unconstrained string on the wire, so an id absent from `labels` — not yet loaded, or a
 * metric added server-side after this build shipped — is the normal case, not an error: it renders
 * as the raw id itself, never blank and never a placeholder like "unknown".
 */
export function metricLabel(id: string, labels: Record<string, string>): string {
  return labels[id] ?? id;
}

/**
 * Reactive shell over the metric ontology fetched by `GET /metrics`. Fetches once per browser
 * session and caches the id-to-label map in module scope — a fixed, small, deployment-constant
 * list, not per-render data — so every caller after the first reads the cache synchronously.
 * Returns an empty map before the fetch resolves and forever after a failed one; both are safe
 * because `metricLabel` falls back to the id it was asked to look up.
 */
export function useMetricLabels(): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>(cachedLabels ?? {});

  useEffect(() => {
    let cancelled = false;
    void fetchMetricLabels().then((result) => {
      if (!cancelled) setLabels(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return labels;
}
