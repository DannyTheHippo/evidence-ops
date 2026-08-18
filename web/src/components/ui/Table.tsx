import type { ReactNode, ThHTMLAttributes } from 'react';

interface TableProps {
  caption: string;
  children: ReactNode;
}

/** Thin wrapper over `<table className="grid">` that adds the one thing every existing grid is
 * missing: a `<caption>`, so `getByRole('table', { name })` resolves. The six existing grids are
 * dense with sticky headers — a visible caption would displace that layout — so `caption` renders
 * visually hidden via `.sr-only` while still giving the table its accessible name. Native table
 * semantics only: no roving-tabindex ARIA grid, nothing beyond what a `<table>` gives for free. */
export default function Table({ caption, children }: TableProps) {
  return (
    <table className="grid">
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
