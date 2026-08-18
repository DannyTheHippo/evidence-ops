import Button from './Button';

interface PagerProps {
  count: number;
  skip: number;
  pageSize: number;
  onSkipChange: (skip: number) => void;
}

/** Previous/Next pager for a skip-based listing, plus the `{count} total` counter. Owns no state
 * of its own — `skip` stays on the page that also feeds the fetch effect, so paging and fetching
 * can never disagree about which page is in view. */
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
      <span className="cell-sub">{count} total</span>
    </div>
  );
}
