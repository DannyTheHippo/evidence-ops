interface SkeletonProps {
  label: string;
  lines?: number;
}

/** Loading placeholder. The shimmer bars are `aria-hidden` — they are decoration, not content —
 * while `label` renders as visually-hidden text inside a `role="status"`/`aria-live="polite"`
 * wrapper, so assistive tech is told content is loading instead of seeing nothing. */
export default function Skeleton({ label, lines = 3 }: SkeletonProps) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="skeleton-lines" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="skeleton-line" />
        ))}
      </div>
    </div>
  );
}
