import type { ReactNode } from 'react';

interface ToolbarProps {
  /** Leading-edge content — a `FilterBar`, a `SegmentedControl`, or both. */
  start?: ReactNode;
  /** Trailing-edge content — typically a result count. */
  end?: ReactNode;
}

/** Layout-only control strip between a page header and its data. It owns no behaviour of its
 * own — `FilterBar`, `SegmentedControl`, and a result count are the caller's concern, this only
 * lays `start` and `end` out on one row. Renders nothing when neither slot is supplied. */
export default function Toolbar({ start, end }: ToolbarProps) {
  if (!start && !end) return null;

  return (
    <div className="toolbar">
      {start && <div className="toolbar-start">{start}</div>}
      {end && <div className="toolbar-end">{end}</div>}
    </div>
  );
}
