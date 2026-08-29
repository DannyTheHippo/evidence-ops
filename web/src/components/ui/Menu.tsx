import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export interface MenuItem {
  label: ReactNode;
  onSelect?: () => void;
  // Renders the danger modifier for an item whose action removes or revokes something.
  tone?: 'danger';
}

interface MenuProps {
  trigger: ReactNode;
  items: MenuItem[];
}

/** Dropdown menu button following the WAI-ARIA menu-button pattern. `Dialog` is a modal `<dialog>`
 * and does not fit this shape — no backdrop, no focus trap, and it dismisses on Escape, an outside
 * click, or focus leaving the surface rather than requiring an explicit close action. An item with
 * no `onSelect` renders `aria-disabled` and reads as informational; an item with `onSelect` is the
 * actionable kind. */
export default function Menu({ trigger, items }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  // Raised by a close path where the browser already moved focus somewhere else as part of the
  // user's own action (an outside click, or Tab carrying focus out of the surface) — restoring the
  // trigger there would fight that action. Escape, an item selection, and unmount-while-open all
  // leave focus with nowhere natural to go, so those paths restore it.
  const skipRestoreFocus = useRef(false);

  useEffect(() => {
    if (!open) return;

    skipRestoreFocus.current = false;
    restoreFocusTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    itemRefs.current[0]?.focus();

    // Outside click closes the menu; React's synthetic events never fire for a target outside
    // this component's own tree, so this is the one listener that must attach to `document`.
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        skipRestoreFocus.current = true;
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      // Explicit restore, mirroring Dialog: the parent can remove this component's DOM before a
      // browser's own focus restore has a chance to run, and jsdom has no native restore at all.
      if (!skipRestoreFocus.current) restoreFocusTo.current?.focus();
    };
  }, [open]);

  const focusItem = (index: number) => {
    itemRefs.current[index]?.focus();
  };

  const currentItemIndex = (event: KeyboardEvent<HTMLDivElement>) =>
    itemRefs.current.indexOf(event.target as HTMLButtonElement);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        break;
      case 'ArrowDown':
        event.preventDefault();
        focusItem((currentItemIndex(event) + 1) % items.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem((currentItemIndex(event) - 1 + items.length) % items.length);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(items.length - 1);
        break;
      default:
        break;
    }
  };

  // Tested against the whole menu, not the surface: the trigger is the surface's sibling, so a
  // surface-scoped check treats focus landing on the trigger as focus leaving the menu and closes
  // it — which the trigger's own click would then immediately undo, reopening the menu it was
  // pressed to dismiss.
  const handleMenuBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!rootRef.current?.contains(event.relatedTarget)) {
      skipRestoreFocus.current = true;
      setOpen(false);
    }
  };

  const handleSelect = (item: MenuItem) => {
    if (!item.onSelect) return;
    item.onSelect();
    setOpen(false);
  };

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className="menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        // Keeps focus inside the surface while the menu is open, so pressing the trigger to dismiss
        // it raises no focusout at all. Without this a browser that reports a null `relatedTarget`
        // on focusout — Safari and Firefox on macOS — closes the menu before the click arrives, and
        // the click reopens it. Focus still returns to the trigger, via the effect's own restore.
        onMouseDown={(event) => {
          if (open) event.preventDefault();
        }}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={handleTriggerKeyDown}
      >
        {trigger}
      </button>
      {open && (
        <div
          className="menu-surface"
          role="menu"
          onKeyDown={handleMenuKeyDown}
          onBlur={handleMenuBlur}
        >
          {items.map((item, index) => (
            <button
              key={index}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              className={item.tone === 'danger' ? 'menu-item menu-item--danger' : 'menu-item'}
              tabIndex={-1}
              aria-disabled={item.onSelect ? undefined : true}
              onClick={() => handleSelect(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
