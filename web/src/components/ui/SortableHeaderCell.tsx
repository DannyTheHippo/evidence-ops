import { IconChevronDown, IconChevronUp } from '../icons';
import { TableHeaderCell } from './Table';

interface SortableHeaderCellProps<F extends string> {
  field: F;
  label: string;
  sort: F;
  direction: 'asc' | 'desc';
  onSort: (field: F) => void;
}

/** `TableHeaderCell` whose content is a button rather than plain text, for a column a caller can
 * sort by. Sets `aria-sort` on the `<th>` — `ascending`/`descending` on the column matching `sort`,
 * absent on every other one, so exactly one column ever claims a direction. The button's own
 * accessible name states the action ("Sort by …"), not just the column label, and folds in the
 * current direction once this column is active — a screen-reader user hears what activating it
 * does rather than only what the column contains. This component owns no sort state itself:
 * clicking always calls `onSort(field)`, and it is the caller's `sort`/`direction` state, updated
 * in response, that decides whether a click toggled the active column's direction or switched the
 * active column entirely. */
export default function SortableHeaderCell<F extends string>({
  field,
  label,
  sort,
  direction,
  onSort,
}: SortableHeaderCellProps<F>) {
  const active = field === sort;
  const actionLabel = active
    ? `Sort by ${label}, sorted ${direction === 'asc' ? 'ascending' : 'descending'}`
    : `Sort by ${label}`;

  return (
    <TableHeaderCell
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        className="th-sort"
        aria-label={actionLabel}
        onClick={() => onSort(field)}
      >
        <span aria-hidden="true">{label}</span>
        {active &&
          (direction === 'asc' ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />)}
      </button>
    </TableHeaderCell>
  );
}
