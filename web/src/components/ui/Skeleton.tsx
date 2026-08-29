interface SkeletonProps {
  label: string;
  lines?: number;
  rows?: number;
  variant?: 'lines' | 'table' | 'form';
}

/** Loading placeholder shaped to match the layout it stands in for. The shimmer content is
 * `aria-hidden` — decoration, not information — while `label` renders as visually-hidden text
 * inside a `role="status"`/`aria-live="polite"` wrapper, so assistive tech is told content is
 * loading instead of seeing nothing.
 *
 * `variant="lines"` (the default) renders `lines` plain shimmer bars, for a paragraph or list
 * standing in for its data. `variant="table"` renders `rows` `.skeleton-row` blocks, one per row a
 * real `<Table>` would show once loaded. `variant="form"` renders `lines` label-plus-control
 * pairs, for a `Field` stack awaiting its data. */
export default function Skeleton({ label, lines = 3, rows = 5, variant = 'lines' }: SkeletonProps) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
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
