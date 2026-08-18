const INTERVAL_UNITS: ReadonlyArray<[label: string, unitMs: number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
];

/**
 * Names a sync cadence in the coarsest unit it clears, rounded to one decimal ("Every 5 minutes").
 * A source with no configured interval still syncs, on the tenant's default cadence — a value the
 * API never returns to the client — so that case is named rather than given an invented number.
 */
export function formatInterval(intervalMs?: number): string {
  if (!intervalMs) return 'Default interval';
  for (const [label, unitMs] of INTERVAL_UNITS) {
    if (intervalMs < unitMs) continue;
    const value = Math.round((intervalMs / unitMs) * 10) / 10;
    return `Every ${value} ${label}${value === 1 ? '' : 's'}`;
  }
  return `Every ${intervalMs} ms`;
}
