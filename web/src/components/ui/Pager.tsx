import { useState } from 'react';
import Button from './Button';

interface PagerProps {
  count: number;
  skip: number;
  pageSize: number;
  onSkipChange: (skip: number) => void;
  /** Renders the page-size select. Omitted, no page-size select renders. */
  onPageSizeChange?: (pageSize: number) => void;
  /** Sizes offered by that select; defaults to [25, 50, 100] — 100 is MAX_PAGINATION_LIMIT. */
  pageSizeOptions?: number[];
  /** Renders the jump-to-page control. */
  showJump?: boolean;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [25, 50, 100];

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

/** Previous/Next pager for a skip-based listing, plus the visible-range counter, an optional
 * page-size select and an optional jump-to-page control. Owns no state of its own besides the
 * jump input's own draft text — `skip` and `pageSize` stay on the page that also feeds the fetch
 * effect, so paging and fetching can never disagree about which page is in view. */
export default function Pager({
  count,
  skip,
  pageSize,
  onSkipChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  showJump = false,
}: PagerProps) {
  const [jumpDraft, setJumpDraft] = useState('');
  const hasPrev = skip > 0;
  const hasNext = skip + pageSize < count;
  const pageCount = Math.max(1, Math.ceil(count / pageSize));

  function goToPage(page: number) {
    const clamped = Math.min(Math.max(page, 1), pageCount);
    onSkipChange((clamped - 1) * pageSize);
  }

  return (
    <nav className="pager" aria-label="Pagination">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-disabled={!hasPrev}
        onClick={() => {
          if (!hasPrev) return;
          onSkipChange(Math.max(0, skip - pageSize));
        }}
      >
        Previous
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-disabled={!hasNext}
        onClick={() => {
          if (!hasNext) return;
          onSkipChange(skip + pageSize);
        }}
      >
        Next
      </Button>
      <span className="cell-sub mono" aria-live="polite">
        {formatRange(count, skip, pageSize)}
      </span>
      {onPageSizeChange && (
        <label className="pager-size">
          Rows per page
          <select
            className="select"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      )}
      {showJump && (
        <form
          className="pager-jump"
          onSubmit={(event) => {
            event.preventDefault();
            const page = Number(jumpDraft);
            if (!Number.isFinite(page) || page < 1) return;
            goToPage(page);
            setJumpDraft('');
          }}
        >
          <label>
            Jump to page
            <input
              type="number"
              min={1}
              max={pageCount}
              value={jumpDraft}
              onChange={(event) => setJumpDraft(event.target.value)}
            />
          </label>
          <Button type="submit" variant="secondary" size="sm">
            Go
          </Button>
        </form>
      )}
    </nav>
  );
}
