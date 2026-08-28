import type { ReactElement, ReactNode } from 'react';
import EmptyState from './ui/EmptyState';
import Skeleton from './ui/Skeleton';

/**
 * The body region a list page can be in, each carrying the data that state needs. A discriminated
 * union rather than independent booleans: a page cannot construct a status that is both `loading`
 * and `ready` at once, because `kind` is a single field and `tsc` rejects any object that doesn't
 * match exactly one of the shapes. `error` is not a member of this union — it is an orthogonal
 * prop on `RecordListPage`, because a failed refresh coexists with rows already on screen (and,
 * separately, with an already-empty result) in a way a single `kind` cannot express. `blank`
 * covers the one region-less case a page still needs: a first-load failure, where there is no
 * body to keep on screen and `error` alone should render.
 */
export type RecordListStatus =
  | { kind: 'loading'; label?: string }
  | { kind: 'blank' }
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
  /** Rendered above the status region whenever present, independent of `status.kind` — a failed
   * refresh renders this alongside `ready`'s rows or `empty`'s state, not in place of them. */
  error?: string;
  status: RecordListStatus;
  /** The ready-state body. `RecordListPage` makes no assumption about its shape: most pages hand
   * it a `<Table>` inside a `.panel`, the review queues hand it a split view. */
  children: ReactNode;
  /** Rendered unconditionally after the status region, inside `.view` — a `<Pager>` belongs here
   * so it stays reachable under every `status.kind`, including `empty`. */
  footer?: ReactNode;
}

/**
 * Shared scaffold for a list page: header (`eyebrow`/`title`/`description` plus an optional
 * `actions` slot), an optional `filters` slot, an optional `error` alert independent of `status`,
 * one region driven by `status` — loading renders `Skeleton`, blank renders nothing, empty renders
 * `EmptyState`, and ready renders `children` — and an optional `footer` rendered after that region
 * regardless of `status.kind`.
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
  error,
  status,
  children,
  footer,
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

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {status.kind === 'loading' && <Skeleton label={status.label ?? `Loading ${title}…`} />}

      {status.kind === 'empty' && (
        <EmptyState
          icon={status.icon}
          title={status.title}
          description={status.description}
          action={status.action}
        />
      )}

      {status.kind === 'ready' && children}

      {footer}
    </div>
  );
}
