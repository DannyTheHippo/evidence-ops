import type { ReactNode } from 'react';

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  /** Rendered beside the title, on the trailing edge of `.page-head`. */
  actions?: ReactNode;
}

/** The `.page-head` block every routed view opens with: an optional `.eyebrow` caption, an `<h1>`
 * title, an optional `.page-sub` description, and an optional trailing `actions` slot. */
export default function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-sub">{description}</p>}
      </div>
      {actions}
    </div>
  );
}
