import type { ReactNode } from 'react';

interface DescriptionListItem {
  term: string;
  description: ReactNode;
}

interface DescriptionListProps {
  items: DescriptionListItem[];
  /** Desktop column count; a description list is always a single column below the layout's
   * narrow breakpoint. Defaults to `1`. */
  columns?: 1 | 2;
}

/** A real `<dl>`/`dt`/`dd` for a term-and-value list, in place of a hand-rolled grid of `<div>`s.
 * Each pair sits in its own wrapper `<div>` — valid inside `<dl>` since HTML5 — so `columns={2}`
 * can lay pairs out on a CSS grid without splitting a term from its own description across
 * columns. */
export default function DescriptionList({ items, columns = 1 }: DescriptionListProps) {
  const className = ['description-list', columns === 2 ? 'description-list--2col' : null]
    .filter(Boolean)
    .join(' ');

  return (
    <dl className={className}>
      {items.map((item, index) => (
        <div className="description-list-item" key={index}>
          <dt className="description-term">{item.term}</dt>
          <dd className="description-detail">{item.description}</dd>
        </div>
      ))}
    </dl>
  );
}
