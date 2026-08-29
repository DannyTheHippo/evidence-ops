import Button from './Button';

interface PagerProps {
  count: number;
  skip: number;
  pageSize: number;
  onSkipChange: (skip: number) => void;
}

/** Formats the pager's visible range as e.g. "1–20 of 143", clamped to `count` on the last page
 * where fewer than `pageSize` items remain. `count === 0` has no range to show — the page renders
 * its own empty state for that case — so this reports a plain "0 of 0" rather than a "1–0" that
 * would imply a page with content. */
function formatRange(count: number, skip: number, pageSize: number): string {
  if (count === 0) return '0 of 0';
  const start = skip + 1;
  const end = Math.min(skip + pageSize, count);
  return `${start}–${end} of ${count}`;
}

/** Previous/Next pager for a skip-based listing, plus the visible-range counter. Owns no state of
 * its own — `skip` stays on the page that also feeds the fetch effect, so paging and fetching can
 * never disagree about which page is in view. */
export default function Pager({ count, skip, pageSize, onSkipChange }: PagerProps) {
  const hasPrev = skip > 0;
  const hasNext = skip + pageSize < count;

  return (
    <div className="pager">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!hasPrev}
        onClick={() => onSkipChange(Math.max(0, skip - pageSize))}
      >
        Previous
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!hasNext}
        onClick={() => onSkipChange(skip + pageSize)}
      >
        Next
      </Button>
      <span className="cell-sub mono">{formatRange(count, skip, pageSize)}</span>
    </div>
  );
}
