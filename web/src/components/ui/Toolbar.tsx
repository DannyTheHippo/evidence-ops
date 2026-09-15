import type { ReactNode } from 'react';

interface ToolbarProps {
  /** Start of the view row — typically a `SegmentedControl` switching between views. */
  view?: ReactNode;
  /** Far edge of the view row — typically a result count or a view-level action. */
  end?: ReactNode;
  /** The filter row below the view row — typically a `FilterBar`. */
  filters?: ReactNode;
}

/** Layout-only control strip between a page header and its data, in two rows. The view row
 * holds `view` at its start and `end` pushed to the far edge, and renders while either is
 * present. The filter row holds `filters` and renders only while `filters` is present. It owns no
 * behaviour of its own — the switch, the filters and the count are the caller's concern. Renders
 * nothing when all three slots are absent. */
export default function Toolbar({ view, end, filters }: ToolbarProps) {
  if (!view && !end && !filters) return null;

  return (
    <div className="toolbar">
      {(view || end) && (
        <div className="toolbar-row toolbar-row--view">
          {view}
          {end && <div className="toolbar-end">{end}</div>}
        </div>
      )}
      {filters && <div className="toolbar-row toolbar-row--filters">{filters}</div>}
    </div>
  );
}
