import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface QueueSlots {
  /** Title (truncated by the caller) plus a status `Badge`, laid out on one row. */
  identity: ReactNode;
  /** The one fact that lets a reader triage the row without opening it. */
  quantifier: ReactNode;
  /** A muted `Timestamp` plus any decay markers, e.g. a Stale badge. */
  age: ReactNode;
  /** Concise accessible name for the row's button. Omitted keeps the button's name as the
   * concatenation of the three slots, which is what MeasuresPage relies on. */
  name?: string;
}

interface QueueListProps<T extends { id: string }> {
  items: T[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Accessible name for the `<ul>` itself. */
  ariaLabel: string;
  renderItem: (item: T) => QueueSlots;
}

/**
 * The shared master-pane list for a review queue's `SplitView` primary: a fixed three-slot row
 * (identity, quantifier, age) on a `button.card.queue-item`, with roving-tabindex keyboard
 * navigation instead of an ARIA listbox — this codebase's rule is not to re-derive a composite
 * widget when plain buttons plus arrow-key handling already satisfy the interaction. Only the
 * selected row is a tab stop; arrowing through the list moves focus and selection together, which
 * is safe here because the detail pane renders from already-fetched page data (no per-keystroke
 * fetch) and the caller's `onSelect` is expected to update the URL with `replace: true`, so it
 * never stacks history entries.
 */
export default function QueueList<T extends { id: string }>({
  items,
  selectedId,
  onSelect,
  ariaLabel,
  renderItem,
}: QueueListProps<T>) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hasSelection = items.some((item) => item.id === selectedId);

  function moveTo(index: number) {
    const clamped = Math.max(0, Math.min(items.length - 1, index));
    const item = items[clamped];
    if (!item) return;
    itemRefs.current[clamped]?.focus();
    onSelect(item.id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveTo(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        break;
      case 'End':
        event.preventDefault();
        moveTo(items.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <ul className="queue-list" aria-label={ariaLabel}>
      {items.map((item, index) => {
        const slots = renderItem(item);
        const isSelected = item.id === selectedId;
        // Falls back to the first row as the one tab stop when nothing on the page matches
        // `selectedId` (a stale link, or a page/filter change) — otherwise no button here would
        // carry tabIndex 0 and the whole list would drop out of the tab order.
        const isTabStop = isSelected || (!hasSelection && index === 0);
        return (
          <li key={item.id}>
            <button
              type="button"
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              className="card queue-item"
              aria-current={isSelected ? 'true' : undefined}
              aria-label={slots.name}
              tabIndex={isTabStop ? 0 : -1}
              onClick={() => onSelect(item.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <div className="queue-item-identity">{slots.identity}</div>
              <div className="queue-item-quantifier">{slots.quantifier}</div>
              <div className="queue-item-age">{slots.age}</div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
