import type { ReactNode } from 'react';

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  /** Rendered beside the title, on the trailing edge of `.page-head`. */
  actions?: ReactNode;
}

/** The `.page-head` block every routed view opens with: an optional `.eyebrow` caption, an `<h1>`
 * title, an optional `.page-sub` description, and an optional trailing `actions` slot wrapped in a
 * single `.page-head-actions` element, so `.page-head`'s two-column grid always has exactly two
 * children regardless of how many elements `actions` contains. The heading carries `tabIndex={-1}`
 * so a route change can move focus to it programmatically without making it a tab stop. */
export default function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="page-title" tabIndex={-1}>
          {title}
        </h1>
        {description && <p className="page-sub">{description}</p>}
      </div>
      <div className="page-head-actions">{actions}</div>
    </div>
  );
}
