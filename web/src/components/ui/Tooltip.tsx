import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  /** The tooltip text. A tooltip with no content renders its child unwrapped. */
  content: ReactNode;
  /** Placement relative to the anchor; defaults to 'top'. */
  placement?: 'top' | 'bottom';
  /** Single focusable or hoverable child the tooltip describes. Cloned with
   * `aria-describedby` pointing at the surface. */
  children: ReactElement;
}

const OPEN_DELAY_MS = 300;
// Closing on the instant neither the anchor nor the surface is active would fail the pointer
// across the visual gap between them (the placement transform's `--space-2` offset) — the
// relatedTarget lands on whatever sits under that gap, not on either element. This grace window
// gives a pointer crossing that gap a chance to land back on the anchor or the surface before the
// tooltip actually closes.
const CLOSE_DELAY_MS = 100;

// jsdom's own UA stylesheet hides any `[popover]` element unconditionally (`:popover-open` never
// matches, since jsdom implements neither the pseudo-class nor showPopover/hidePopover) — carrying
// the attribute there would fail closed instead of open. Feature-detecting and omitting it keeps
// the surface a plain rendered box; the attribute is only ever set where the API exists, and it
// buys top-layer promotion past a scroll container's clipping, not placement — placement comes
// from the anchor's own box either way.
const supportsPopover =
  typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';

/**
 * Accessible tooltip surface for a single hoverable or focusable child. Opens 300 ms after pointer
 * hover or focus lands on the anchor, and closes 100 ms after neither is active any longer — the
 * surface counts as part of the tooltip while pointed at, so moving from the anchor onto the
 * surface never closes it, and the grace window covers the visual gap a pointer crosses in
 * between the two (WCAG 1.4.13). Escape dismisses without moving focus, from anywhere in the
 * document while the tooltip is open, not only while focus sits on the anchor.
 *
 * The surface renders through a portal on `document.body`, never as a descendant of the anchor, so
 * its text cannot join the accessible name of an interactive ancestor — a `RowLink` wrapping a
 * truncated cell keeps the cell's own name while the tooltip is open. `aria-describedby` still
 * reaches the surface by id, and the surface is positioned as a fixed box against the anchor's
 * viewport rectangle, tracked while it is open.
 */
export default function Tooltip({
  content,
  placement = 'top',
  children,
}: TooltipProps): ReactElement {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const surfaceId = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerActive = useRef(false);
  const focusActive = useRef(false);
  const open = anchorRect !== null;
  // `evaluate()` below reads `open` through this ref rather than the render-scoped variable
  // above. The listener effect below is passive and re-subscribes the listeners only after a
  // commit; a listener closure from before that commit still handles any event dispatched in
  // between, and reads this ref. `requestAnchorRect` below is the only way `anchorRect` ever
  // changes, and it writes this ref synchronously at the moment the change is requested rather
  // than waiting for React to commit it, so the ref already holds the requested value for an
  // event landing between the request and the commit, not only between the commit and the
  // listener re-subscription.
  const openRef = useRef(open);
  // The one place `anchorRect` is written; writing `openRef` here is what keeps it current at
  // every call site.
  const requestAnchorRect = useCallback((rect: DOMRect | null) => {
    openRef.current = rect !== null;
    setAnchorRect(rect);
  }, []);

  useEffect(() => {
    const clearTimer = () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
    };

    const anchor = anchorRef.current;
    // No anchor is rendered without content, so nothing is left to open, close or describe.
    if (!anchor || !content) {
      pointerActive.current = false;
      focusActive.current = false;
      clearTimer();
      return undefined;
    }
    const surface = surfaceRef.current;

    // The open surface lives in a portal, so `anchor.contains()` alone does not describe "still
    // inside the tooltip" — the surface is the other half of that region.
    const inside = (node: Node | null) =>
      node !== null && (anchor.contains(node) || surface?.contains(node) === true);

    // Active-and-closed schedules the open; inactive-and-open schedules the close. Active-and-open
    // and inactive-and-closed are no-ops beyond the timer clear above — there is nothing pending to
    // change.
    const evaluate = () => {
      clearTimer();
      const active = pointerActive.current || focusActive.current;
      if (active && !openRef.current) {
        timer.current = setTimeout(() => {
          timer.current = null;
          requestAnchorRect(anchor.getBoundingClientRect());
        }, OPEN_DELAY_MS);
      } else if (!active && openRef.current) {
        timer.current = setTimeout(() => {
          timer.current = null;
          requestAnchorRect(null);
        }, CLOSE_DELAY_MS);
      }
    };

    // pointerover/pointerout bubble, unlike pointerenter/pointerleave, so one listener per element
    // covers the child and (once open) the surface. A relatedTarget still inside the anchor or the
    // surface means the pointer moved between the two rather than truly leaving.
    const handlePointerOver = (event: PointerEvent) => {
      if (inside(event.relatedTarget as Node | null)) return;
      pointerActive.current = true;
      evaluate();
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (inside(event.relatedTarget as Node | null)) return;
      pointerActive.current = false;
      evaluate();
    };
    const handleFocusIn = () => {
      focusActive.current = true;
      evaluate();
    };
    const handleFocusOut = (event: FocusEvent) => {
      if (inside(event.relatedTarget as Node | null)) return;
      focusActive.current = false;
      evaluate();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      pointerActive.current = false;
      focusActive.current = false;
      clearTimer();
      requestAnchorRect(null);
    };

    anchor.addEventListener('pointerover', handlePointerOver);
    anchor.addEventListener('pointerout', handlePointerOut);
    anchor.addEventListener('focusin', handleFocusIn);
    anchor.addEventListener('focusout', handleFocusOut);
    anchor.addEventListener('keydown', handleKeyDown);
    surface?.addEventListener('pointerover', handlePointerOver);
    surface?.addEventListener('pointerout', handlePointerOut);

    // The cleanup leaves a pending open or close timer running: a re-run for new content keeps the
    // same anchor, and the timer's callback reads neither `content` nor the listeners, so the
    // transition still lands on schedule and the surface renders whatever content is current then.
    return () => {
      anchor.removeEventListener('pointerover', handlePointerOver);
      anchor.removeEventListener('pointerout', handlePointerOut);
      anchor.removeEventListener('focusin', handleFocusIn);
      anchor.removeEventListener('focusout', handleFocusOut);
      anchor.removeEventListener('keydown', handleKeyDown);
      surface?.removeEventListener('pointerover', handlePointerOver);
      surface?.removeEventListener('pointerout', handlePointerOut);
    };
  }, [content, open, requestAnchorRect]);

  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !open) return;
    // Guarded rather than gated on `supportsPopover` alone — a UA can carry the attribute yet
    // reject the call for an unrelated reason, and this must still fail open into the plain
    // conditional render rather than throwing.
    if (typeof surface.showPopover === 'function') {
      try {
        surface.showPopover();
      } catch {
        // Already shown.
      }
    }
  }, [open]);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || !open) return undefined;
    // A fixed box holds viewport coordinates, so anything that moves the anchor within the
    // viewport — an outer scroll container as much as the page itself, hence the capture phase —
    // leaves the surface behind until it is re-measured.
    const reposition = () => requestAnchorRect(anchor.getBoundingClientRect());
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);

    // The main effect's own keydown listener only bubbles from within the anchor, so it never
    // fires for a hover-opened tooltip when focus sits elsewhere on the page. Escape must still
    // dismiss it from anywhere while it is open.
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      pointerActive.current = false;
      focusActive.current = false;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      requestAnchorRect(null);
    };
    document.addEventListener('keydown', handleDocumentKeyDown);

    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('keydown', handleDocumentKeyDown);
    };
  }, [open, requestAnchorRect]);

  if (!content) return children;

  return (
    <span ref={anchorRef} className="tooltip-anchor">
      {cloneElement(children as ReactElement<Record<string, unknown>>, {
        'aria-describedby': surfaceId,
      })}
      {anchorRect &&
        createPortal(
          <div
            ref={surfaceRef}
            id={surfaceId}
            role="tooltip"
            popover={supportsPopover ? 'manual' : undefined}
            className={`tooltip-surface tooltip-surface--${placement}`}
            style={{
              left: anchorRect.left + anchorRect.width / 2,
              top: placement === 'top' ? anchorRect.top : anchorRect.bottom,
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
