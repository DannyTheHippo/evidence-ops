import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';

interface PopoverProps {
  /** Rendered as the anchor; receives `aria-expanded` and `aria-controls`. Wrapped, unchanged, in
   * an owned `<span>` this component puts its own `ref` on — see the component docstring — so a
   * caller's own ref on `trigger` is left alone. */
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name for the surface, applied as `aria-label`. */
  label: string;
  /** Preferred inline-axis side; flipped to the other side, and flipped upward on the block axis,
   * whenever the preferred side would overflow the viewport (see the component docstring). */
  placement?: 'bottom-start' | 'bottom-end';
  children: ReactNode;
}

const placementClass: Record<NonNullable<PopoverProps['placement']>, string> = {
  'bottom-start': 'popover-surface--bottom-start',
  'bottom-end': 'popover-surface--bottom-end',
};

/** Top-layer overlay via the native `popover` attribute, positioned against `trigger` through CSS
 * anchor positioning where the browser supports it, and as a `position: fixed` box measured off the
 * anchor wrapper and the surface itself where it does not. Both paths flip a surface that would
 * overflow the viewport's preferred inline edge to the opposite edge, and flip it upward when the
 * preferred (downward) side would overflow — the top-layer path natively, through
 * `position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline` on
 * `.popover-surface[popover]` (primitives.css); the no-anchor path in the layout effect below. The
 * no-anchor path also re-measures on a `scroll` or `resize` while it stays open, so a surface that
 * scrolled with its trigger — the People table's row menus, for one — never keeps a coordinate the
 * trigger has already moved away from. The no-anchor path's `position: fixed` is also what keeps it
 * from being clipped by an ancestor `.panel`'s `overflow: auto` — fixed positioning is unaffected by
 * an ancestor's overflow, the same escape the top layer gives the anchor path. Owns only the
 * positioning host and the trigger's `aria-expanded`/`aria-controls` wiring — `children` carries its
 * own role and keyboard handling, so `Menu`'s `role="menu"` surface and a future listbox surface can
 * both sit on top of it unchanged. */
export default function Popover({
  trigger,
  open,
  onOpenChange,
  label,
  placement = 'bottom-start',
  children,
}: PopoverProps): ReactElement {
  const surfaceId = useId();
  const anchorName = `--popover-anchor-${surfaceId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  // A plain `<span>` this component renders and refs directly — never a ref forwarded onto
  // `trigger` itself, which would mean reading it back out through `cloneElement` during render.
  // `.popover-anchor` is `display: inline-block` (primitives.css), so its measured box matches
  // `trigger`'s own, the same wrapping `Tooltip.tsx` uses for its own anchor measurement.
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // A top-layer surface with no anchor support has no position relative to the trigger, so the
  // `popover` attribute is set only where anchor positioning exists. Without it the surface fails
  // OPEN into the measured `position: fixed` box the layout effect below computes.
  const anchorPositioning = typeof CSS !== 'undefined' && CSS.supports('anchor-name: --a');
  // Only the no-anchor fallback needs this — the anchor path's flip is pure CSS.
  const [fallback, setFallback] = useState<{ top: number; left: number; openUp: boolean } | null>(
    null,
  );

  // Recomputes the fixed box from the anchor's and the surface's current rects. Stable across
  // renders except when `placement` changes, so the scroll/resize effect below can depend on it
  // without tearing its listeners down on every render.
  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    const surface = surfaceRef.current;
    if (!anchor || !surface) return;

    const anchorRect = anchor.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();

    const preferEnd = placement === 'bottom-end';
    let left = preferEnd ? anchorRect.right - surfaceRect.width : anchorRect.left;
    if (preferEnd ? left < 0 : left + surfaceRect.width > window.innerWidth) {
      left = preferEnd ? anchorRect.left : anchorRect.right - surfaceRect.width;
    }

    const openUp = anchorRect.bottom + surfaceRect.height > window.innerHeight;
    const top = openUp ? anchorRect.top - surfaceRect.height : anchorRect.bottom;

    setFallback({ top, left, openUp });
  }, [placement]);

  // Runs before paint so a surface that needs to flip never flashes at its unflipped position
  // first. Depends on `placement` and re-measures on every open since a trigger's position (the
  // People table's row order, say) can differ between opens.
  useLayoutEffect(() => {
    // While closed or anchor-positioned, `fallback` is simply unread — the surface renders only
    // while `open`, and a stale value from a previous open is overwritten by this same effect,
    // synchronously before paint, the next time it opens.
    if (!open || anchorPositioning) return;
    measure();
  }, [open, anchorPositioning, measure]);

  // A fixed box holds viewport coordinates, so anything that moves the anchor within the
  // viewport — an outer scroll container as much as the page itself, hence the capture phase —
  // leaves the surface behind until it is re-measured, the same problem `Tooltip.tsx` solves.
  // Without this, the People table's own `overflow-y: auto` (`.container`) can scroll a row's
  // menu away from the trigger it still names in its title.
  useEffect(() => {
    if (!open || anchorPositioning) return undefined;
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, anchorPositioning, measure]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !open || !surface.hasAttribute('popover')) return;

    // jsdom implements neither showPopover() nor hidePopover(): this is a UI affordance, so it
    // fails OPEN (rendering the surface visibly) rather than throwing or swallowing the content,
    // exactly as Dialog does for showModal().
    if (typeof surface.showPopover === 'function') {
      try {
        surface.showPopover();
      } catch {
        surface.removeAttribute('popover');
      }
    } else {
      surface.removeAttribute('popover');
    }

    return () => {
      // hidePopover() throws on an element the caller has already removed from the document by
      // the time this cleanup runs, so removal itself is left to do the hiding in that case.
      if (typeof surface.hidePopover === 'function') {
        try {
          surface.hidePopover();
        } catch {
          // already removed from the document
        }
      }
    };
  }, [open]);

  const anchoredTrigger = trigger as ReactElement<HTMLAttributes<HTMLElement>>;
  const clonedTrigger = cloneElement(anchoredTrigger, {
    'aria-expanded': open,
    'aria-controls': surfaceId,
    style: { ...anchoredTrigger.props.style, anchorName },
  });

  return (
    <>
      <span ref={anchorRef} className="popover-anchor">
        {clonedTrigger}
      </span>
      {open && (
        <div
          ref={surfaceRef}
          id={surfaceId}
          popover={anchorPositioning ? 'manual' : undefined}
          className={
            anchorPositioning
              ? `popover-surface ${placementClass[placement]}`
              : `popover-surface ${placementClass[placement]} ${
                  fallback?.openUp ? 'popover-surface--open-up' : 'popover-surface--open-down'
                }`
          }
          aria-label={label}
          style={
            anchorPositioning
              ? { positionAnchor: anchorName }
              : { top: fallback?.top ?? 0, left: fallback?.left ?? 0 }
          }
          // The toggle event only echoes this component's own showPopover()/hidePopover() calls; it
          // adds no light-dismiss path.
          onToggle={(event) => onOpenChange(event.newState === 'open')}
        >
          {children}
        </div>
      )}
    </>
  );
}
