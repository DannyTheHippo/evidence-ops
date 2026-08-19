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
}: EmptyStateProps) {
  return (
    <div className={['empty-state', className].filter(Boolean).join(' ')}>
      {icon && (
        <div className="empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="empty-state-title">{title}</p>
      {description && <p className="empty-state-description">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
