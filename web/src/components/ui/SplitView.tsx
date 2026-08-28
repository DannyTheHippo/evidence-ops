import type { ReactNode } from 'react';

interface SplitViewProps {
  primary: ReactNode;
  secondary: ReactNode;
  primaryLabel: string;
  secondaryLabel: string;
  ratio: 'queue' | 'even' | 'reader';
}

const ratioClass: Record<SplitViewProps['ratio'], string> = {
  queue: 'split-view--queue',
  even: 'split-view--even',
  reader: 'split-view--reader',
};

/** Two-pane layout: `primary` and `secondary`, each a labelled `<section>` landmark so a keyboard
 * or screen-reader user can jump straight between them. `ratio` only sets the desktop column
 * widths — `queue` (a narrow list beside a wide detail pane), `even` (equal halves), `reader` (a
 * wide reading pane beside a narrow sidebar) — via the `.split-view--*` modifier in
 * `primitives.css`. Below 1023px that stylesheet collapses the grid to a single column; nothing
 * here changes, because both panes stay mounted at every width. There is no conditional rendering
 * and no `display: none` anywhere in this component or its CSS — a pane that vanished on a narrow
 * screen would be a feature that silently does not exist there. */
export default function SplitView({
  primary,
  secondary,
  primaryLabel,
  secondaryLabel,
  ratio,
}: SplitViewProps) {
  return (
    <div className={`split-view ${ratioClass[ratio]}`}>
      <section className="split-view-pane" aria-label={primaryLabel}>
        {primary}
      </section>
      <section className="split-view-pane" aria-label={secondaryLabel}>
        {secondary}
      </section>
    </div>
  );
}
