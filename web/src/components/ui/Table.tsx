import {
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from 'react';
import { Link } from 'react-router-dom';

interface TableProps {
  caption: string;
  /** Appended after `grid`, for a page-specific modifier — a `<colgroup>` table's `min-width`
   * floor, sized to its own fixed columns, lives here rather than as an inline style. */
  className?: string;
  children: ReactNode;
}

/** Thin wrapper over `<table className="grid">` that adds the one thing every existing grid is
 * missing: a `<caption>`, so `getByRole('table', { name })` resolves. The six existing grids are
 * dense with sticky headers — a visible caption would displace that layout — so `caption` renders
 * visually hidden via `.sr-only` while still giving the table its accessible name. Native table
 * semantics only: no roving-tabindex ARIA grid, nothing beyond what a `<table>` gives for free. */
export default function Table({ caption, className, children }: TableProps) {
  return (
    <table className={className ? `grid ${className}` : 'grid'}>
      <caption className="sr-only">{caption}</caption>
      {children}
    </table>
  );
}

/** `<th scope="col">` for a column header cell — the one piece of table semantics a plain `<th>`
 * does not supply on its own. */
export function TableHeaderCell({ children, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th scope="col" {...rest}>
      {children}
    </th>
  );
}

interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  label?: string;
}

/** `<td>` that carries its column header as `data-label` — the mechanism `primitives.css`'s narrow
 * `.grid` query reads via `content: attr(data-label)` to turn each row into a labelled card below
 * 768px. A cell with no `label` renders a plain `<td>`: the CSS scopes the label rule to
 * `[data-label]`, so an unlabelled cell never reserves a gutter for a label it doesn't have. This
 * is the one place the stacked layout is driven from; every table still supplies its own `label`
 * per cell, because only the page knows what its columns mean. */
export function TableCell({ label, children, ...rest }: TableCellProps) {
  return (
    <td data-label={label} {...rest}>
      {children}
    </td>
  );
}

interface TableRowProps {
  to?: string;
  children: ReactNode;
  className?: string;
  /** Marks the row as the current selection, e.g. the document workbench's active version — adds
   * `row--selected` alongside whatever else the row's className resolves to, and sets
   * `aria-current="true"` so the selection is a programmatic state, not only a visual one. */
  selected?: boolean;
}

/** `<tr>` that optionally carries a destination. With `to`, a plain left click anywhere in the
 * row activates the `RowLink` rendered inside one of its cells — but that `RowLink`, not this
 * handler, is the mechanism of record: it is what a keyboard or screen-reader user actually
 * reaches, and this only defers to it for a mouse user who clicked elsewhere in the row. The
 * handler steps aside for a modified click (reserved for the link's own open-in-new-tab
 * behaviour), a click that landed on another interactive control, and a click that produced a
 * text selection — an unconditional row-covering overlay would paint above the row's own inline
 * text and block that selection outright, which is why this is a click listener and not a `<a>`
 * stretched across the row. Without `to`, this is an unmodified `<tr>`. */
export function TableRow({ to, children, className, selected }: TableRowProps) {
  const rowRef = useRef<HTMLTableRowElement | null>(null);

  const handleClick = (event: ReactMouseEvent<HTMLTableRowElement>) => {
    if (!to) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    if (event.defaultPrevented) return;
    if (window.getSelection()?.toString()) return;
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, select, textarea, label')) return;
    rowRef.current?.querySelector<HTMLAnchorElement>('a[data-row-link]')?.click();
  };

  const classes = [to ? 'row--linked' : null, selected ? 'row--selected' : null, className]
    .filter(Boolean)
    .join(' ');

  return (
    <tr
      ref={rowRef}
      className={classes || undefined}
      aria-current={selected ? 'true' : undefined}
      onClick={to ? handleClick : undefined}
    >
      {children}
    </tr>
  );
}

interface RowLinkProps {
  to: string;
  children: ReactNode;
  /** Set by a wrapping `Tooltip`, so the link that takes keyboard focus is also the element the
   * tooltip describes. */
  'aria-describedby'?: string;
}

/** The real, keyboard-reachable and screen-reader-visible anchor a `TableRow`'s click-anywhere
 * enhancement defers to. Render it once, inside the row's primary cell. */
export function RowLink({ to, children, 'aria-describedby': describedBy }: RowLinkProps) {
  return (
    <Link to={to} data-row-link className="row-link" aria-describedby={describedBy}>
      {children}
    </Link>
  );
}
