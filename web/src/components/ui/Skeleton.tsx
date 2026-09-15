import { useEffect, useRef } from 'react';

interface SkeletonProps {
  label: string;
  lines?: number;
  rows?: number;
  variant?: 'lines' | 'table' | 'form';
}

/** Loading placeholder shaped to match the layout it stands in for. The shimmer content is
 * `aria-hidden` — decoration, not information — while `label` renders as visually-hidden text
 * inside a `role="status"`/`aria-live="polite"` wrapper, so assistive tech is told content is
 * loading instead of seeing nothing. The wrapper mounts with its `.sr-only` span empty and fills
 * it with `label` from an effect, so the region registers on its own paint before the text that
 * changes inside it arrives — a live region and its first content landing in the same paint is
 * routinely missed by screen readers.
 *
 * `variant="lines"` (the default) renders `lines` plain shimmer bars, for a paragraph or list
 * standing in for its data. `variant="table"` renders `rows` `.skeleton-row` blocks, one per row a
 * real `<Table>` would show once loaded. `variant="form"` renders `lines` label-plus-control
 * pairs, for a `Field` stack awaiting its data. */
export default function Skeleton({ label, lines = 3, rows = 5, variant = 'lines' }: SkeletonProps) {
  const labelRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (labelRef.current) labelRef.current.textContent = label;
  }, [label]);

  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only" ref={labelRef} />
      <div className={`skeleton-${variant}`} aria-hidden="true">
        {variant === 'table' &&
          Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton-row" />)}
        {variant === 'form' &&
          Array.from({ length: lines }, (_, i) => (
            <div key={i} className="skeleton-field">
              <div className="skeleton-field-label" />
              <div className="skeleton-field-input" />
            </div>
          ))}
        {variant === 'lines' &&
          Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton-line" />)}
      </div>
    </div>
  );
}
