import type { ReactElement, ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactElement;
  title: string;
  description?: string;
  action?: ReactNode;
  /** Modifier appended to the root's class list, for a variant of the same object —
   * `empty-state--inline` where this stands in for one section of a populated page rather than for
   * a whole view. Not an escape hatch for arbitrary styling. */
  className?: string;
  /** Renders `title` as an `<h2>`/`<h3>` instead of a `<p>`, so a whole-view empty state is
   * reachable by heading navigation. Omitted, the title renders as a `<p>` — a section-level
   * empty state inside an already-headed view has nothing to head. */
  headingLevel?: 2 | 3;
}

/** Plain content region for a list or view with nothing to show. Not an error and not a status,
 * so it carries no role and no live region — an empty screen is an invitation to act, and
 * `action` is where that next step goes. */
export default function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  headingLevel,
}: EmptyStateProps) {
  const Heading = headingLevel === 2 ? 'h2' : headingLevel === 3 ? 'h3' : 'p';

  return (
    <div className={['empty-state', className].filter(Boolean).join(' ')}>
      {icon && (
        <div className="empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <Heading className="empty-state-title">{title}</Heading>
      {description && <p className="empty-state-description">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
