import type { ReactElement, ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactElement;
  title: string;
  description?: string;
  action?: ReactNode;
}

/** Plain content region for a list or view with nothing to show. Not an error and not a status,
 * so it carries no role and no live region — an empty screen is an invitation to act, and
 * `action` is where that next step goes. */
export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
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
