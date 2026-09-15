import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import Popover from './Popover';

export interface MenuItem {
  label: ReactNode;
  onSelect?: () => void;
  // Renders the danger modifier for an item whose action removes or revokes something.
  tone?: 'danger';
}

interface MenuProps {
  trigger: ReactNode;
  items: MenuItem[];
  /** Which trigger edge the surface prefers to align to; `Popover` flips it to the other edge (and
   * upward) on its own whenever the preferred side would overflow the viewport, so this is a hint
   * for the common case, not a requirement — a caller near the viewport's end edge can still pass
   * `'bottom-end'` to skip the first render's flip. Defaults to `'bottom-start'`. */
  placement?: 'bottom-start' | 'bottom-end';
}

/** Dropdown menu button following the WAI-ARIA menu-button pattern, its surface rendered through
 * `Popover`. An item with no `onSelect` renders as non-interactive text; an item with `onSelect`
 * is the actionable kind. */
export default function Menu({ trigger, items, placement }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  // Raised by a close path where the browser already moved focus somewhere else as part of the
  // user's own action (an outside click, or Tab carrying focus out of the surface) — restoring the
  // trigger there would fight that action. Escape, an item selection, and unmount-while-open all
  // leave focus with nowhere natural to go, so those paths restore it.
  const skipRestoreFocus = useRef(false);
  // Set by the trigger's own ArrowUp/ArrowDown before opening, so the effect below knows which end
  // of the actionable list to focus first — ArrowUp opens onto the last item, everything else onto
  // the first.
  const openAtLastItem = useRef(false);
  const triggerId = useId();

  const actionableCount = items.filter((item) => item.onSelect).length;
  // Refreshed every render (mirroring `useSourceSync`'s `onSettledRef`) so the open effect below
  // reads the count as of the render that opened the menu without listing it as a dependency —
  // listing it would re-run the effect, and re-focus the first item, whenever `items` changes while
  // the menu is already open.
  const actionableCountRef = useRef(actionableCount);
  useEffect(() => {
    actionableCountRef.current = actionableCount;
  });

  useEffect(() => {
    if (!open) return;

    skipRestoreFocus.current = false;
    restoreFocusTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    itemRefs.current[openAtLastItem.current ? actionableCountRef.current - 1 : 0]?.focus();

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

    // value at the moment the menu opens, not to re-run this effect when items change while open
  }, [open]);

  const focusItem = (index: number) => {
    itemRefs.current[index]?.focus();
  };

  const currentItemIndex = (event: KeyboardEvent<HTMLDivElement>) =>
    itemRefs.current.indexOf(event.target as HTMLButtonElement);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openAtLastItem.current = event.key === 'ArrowUp';
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
        focusItem((currentItemIndex(event) + 1) % actionableCount);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem((currentItemIndex(event) - 1 + actionableCount) % actionableCount);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(actionableCount - 1);
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
      <Popover
        trigger={
          <button
            type="button"
            id={triggerId}
            className="menu-trigger"
            aria-haspopup="menu"
            // Keeps focus inside the surface while the menu is open, so pressing the trigger to
            // dismiss it raises no focusout at all. Without this a browser that reports a null
            // relatedTarget on focusout — Safari and Firefox on macOS — closes the menu before the
            // click arrives, and the click reopens it. Focus still returns to the trigger, via the
            // effect's own restore.
            onMouseDown={(event) => {
              if (open) event.preventDefault();
            }}
            onClick={() => setOpen((was) => !was)}
            onKeyDown={handleTriggerKeyDown}
          >
            {trigger}
          </button>
        }
        open={open}
        onOpenChange={setOpen}
        label="Menu"
        placement={placement}
      >
        <div
          className="menu-surface"
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={handleMenuKeyDown}
          onBlur={handleMenuBlur}
        >
          {items.map((item, index) => {
            if (!item.onSelect) {
              return (
                <div key={index} className="menu-info">
                  {item.label}
                </div>
              );
            }
            // The index among actionable items only, since inert `menu-info` rows share the
            // outer `index` but never get a ref slot.
            const refIndex = items.slice(0, index).filter((it) => it.onSelect).length;
            return (
              <button
                key={index}
                ref={(el) => {
                  itemRefs.current[refIndex] = el;
                }}
                type="button"
                role="menuitem"
                className={item.tone === 'danger' ? 'menu-item menu-item--danger' : 'menu-item'}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSelect(item)}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}
