import { formatAbsoluteTimestamp, formatRelativeTimestamp } from '../../lib/format-timestamp';

interface TimestampProps {
  value: string;
}

function isValidIso(value: string): boolean {
  return value !== '' && !Number.isNaN(new Date(value).getTime());
}

/** Real `<time>` element: the visible text is `formatRelativeTimestamp`'s coarse phrase, `title`
 * is `formatAbsoluteTimestamp`'s full local timestamp for a reader who wants the precise value.
 * `dateTime` is omitted for an empty or unparseable `value` — both formatters already fall back to
 * '—' for display, but an invalid `datetime` attribute would still assert a machine-readable value
 * that does not exist, which is worse than the attribute being absent. */
export default function Timestamp({ value }: TimestampProps) {
  return (
    <time dateTime={isValidIso(value) ? value : undefined} title={formatAbsoluteTimestamp(value)}>
      {formatRelativeTimestamp(value)}
    </time>
  );
}
