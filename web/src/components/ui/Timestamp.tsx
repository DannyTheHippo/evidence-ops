import { formatAbsoluteTimestamp, formatRelativeTimestamp } from '../../lib/format-timestamp';

interface TimestampProps {
  value: string;
  /** Selects how much of the value renders visibly; defaults to `'relative'`. `'relative'` shows
   * the coarse phrase, with the exact value as visually hidden text inside the same `<time>`.
   * `'absolute'` shows only the exact value. `'both'` shows the coarse phrase followed by the
   * exact value, both visible. */
  format?: 'relative' | 'absolute' | 'both';
}

function isValidIso(value: string): boolean {
  return value !== '' && !Number.isNaN(new Date(value).getTime());
}

/** Real `<time>` element. `dateTime` is omitted for an empty or unparseable `value` — both
 * formatters already fall back to '—' for display, but an invalid `datetime` attribute would still
 * assert a machine-readable value that does not exist, which is worse than the attribute being
 * absent. Carries no `title`: the exact value is always reachable through the rendered content
 * instead, per `format`. */
export default function Timestamp({ value, format = 'relative' }: TimestampProps) {
  const dateTime = isValidIso(value) ? value : undefined;
  const relative = formatRelativeTimestamp(value);
  const absolute = formatAbsoluteTimestamp(value);

  if (format === 'absolute') {
    return <time dateTime={dateTime}>{absolute}</time>;
  }

  if (format === 'both') {
    return <time dateTime={dateTime}>{`${relative} (${absolute})`}</time>;
  }

  return (
    <time dateTime={dateTime}>
      {relative}
      <span className="sr-only"> ({absolute})</span>
    </time>
  );
}
