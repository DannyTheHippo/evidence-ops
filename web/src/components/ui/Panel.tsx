import type { ReactNode } from 'react';

interface PanelProps {
  /** Names the panel's contents for a screen reader — the scrollbar this element falls back to on
   * a narrow viewport is otherwise invisible to assistive tech and unreachable except by mouse,
   * required rather than optional because an unnamed region is worse than none. */
  'aria-label': string;
  children: ReactNode;
  className?: string;
}

/** The scrollable-region wrapper a wide table needs: `role="region"` plus `aria-label` give the
 * fallback horizontal scrollbar (`.panel`'s `overflow: auto`, between 768px and 1023px) an
 * announced name instead of an anonymous `<div>`, and `tabIndex={0}` makes the container itself a
 * focusable stop so keyboard scrolling can reach content a mouse would otherwise be required for. */
export default function Panel({ 'aria-label': ariaLabel, children, className }: PanelProps) {
  return (
    <section
      className={['panel', className].filter(Boolean).join(' ')}
      tabIndex={0}
      role="region"
      aria-label={ariaLabel}
    >
      {children}
    </section>
  );
}
