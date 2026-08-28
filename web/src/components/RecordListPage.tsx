import type { ReactElement, ReactNode } from 'react';
import EmptyState from './ui/EmptyState';
import Skeleton from './ui/Skeleton';

/**
 * The four states a list page can be in, each carrying the data that state needs. A discriminated
 * union rather than independent booleans: a page cannot construct a status that is both `loading`
 * and `ready` at once, because `kind` is a single field and `tsc` rejects any object that doesn't
 * match exactly one of the four shapes.
 */
export type RecordListStatus =
  | { kind: 'loading'; label?: string }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; icon?: ReactElement; title: string; description?: string; action?: ReactNode }
  | { kind: 'ready' };

export interface RecordListPageProps {
  eyebrow: string;
  title: string;
  description: string;
  /** Rendered beside the title, on the trailing edge of `.page-head`. */
  actions?: ReactNode;
  /** Rendered below the header, ahead of the status region — typically a `FilterBar`. */
  filters?: ReactNode;
  status: RecordListStatus;
  /** The ready-state body. `RecordListPage` makes no assumption about its shape: most pages hand
   * it a `<Table>` inside a `.panel`, the review queues hand it a split view. */
  children: ReactNode;
}

/**
 * Shared scaffold for a list page: header (`eyebrow`/`title`/`description` plus an optional
 * `actions` slot), an optional `filters` slot, and one region driven by `status` — loading renders
 * `Skeleton`, error renders the page-level `.error` alert, empty renders `EmptyState`, and ready
 * renders `children`. Exactly one region renders per status.
 *
 * Accessibility contract a consumer owes: when `children` scrolls horizontally inside `.panel` (a
 * wide table between 768px and 1023px), `primitives.css` documents that fallback scrollbar as one
 * the app never announces to assistive tech — nothing about it is otherwise reachable except by a
 * mouse. The page that renders that scrolling element is the only one that knows which element it
 * is, so `RecordListPage` does not add this itself; the consumer must put `tabIndex={0}`,
 * `role="region"`, and an `aria-label` naming the table's contents on it. `tabIndex={0}` makes the
 * scrolling container itself a focusable stop, so keyboard scrolling reaches content a mouse would
 * otherwise be required for; `role="region"` plus `aria-label` give that stop a name a screen
 * reader announces, rather than an anonymous, unlabelled `<div>`.
 */
export default function RecordListPage({
  eyebrow,
  title,
  description,
  actions,
  filters,
  status,
  children,
}: RecordListPageProps) {
  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">{description}</p>
        </div>
        {actions}
      </div>

      {filters}

      {status.kind === 'loading' && <Skeleton label={status.label ?? `Loading ${title}…`} />}

      {status.kind === 'error' && (
        <p className="error error--page" role="alert">
          {status.message}
        </p>
      )}

      {status.kind === 'empty' && (
        <EmptyState
          icon={status.icon}
          title={status.title}
          description={status.description}
          action={status.action}
        />
      )}

      {status.kind === 'ready' && children}
    </div>
  );
}
