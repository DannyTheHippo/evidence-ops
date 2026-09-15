import { useRef } from 'react';
import type { ReactNode } from 'react';
import Button from './Button';

interface FilterBarProps {
  children: ReactNode;
  onClear: () => void;
  hasFilter: boolean;
  /** Accessible name for the filter `<form>`, applied as `aria-label`; defaults to `'Filters'` so
   * every caller keeps a named landmark without passing anything. */
  label?: string;
}

/** Filter form for the controls the caller renders as `children`. Filters apply as they change:
 * each control writes the page's URL state itself, so there is no Apply button and this component
 * owns no filter value. Submitting the form — which a browser does on Enter only when the form
 * holds exactly one field that blocks implicit submission — is always prevented and never reloads
 * the page; every text filter applies its own Enter through its own control instead, since that
 * also covers a form with two or more such fields, where implicit submission never fires at all.
 * `Clear filters` renders as the form's last child only while `hasFilter` is true; clicking it
 * calls `onClear` and then focuses the form's first control, because the button itself unmounts
 * once nothing is left to clear. */
export default function FilterBar({
  children,
  onClear,
  hasFilter,
  label = 'Filters',
}: FilterBarProps) {
  const formRef = useRef<HTMLFormElement>(null);

  function handleClear() {
    onClear();
    const first = formRef.current?.elements[0];
    if (first instanceof HTMLElement) first.focus();
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => e.preventDefault()}
      className="filter-bar"
      aria-label={label}
    >
      {children}
      {hasFilter && (
        <Button type="button" variant="ghost" onClick={handleClear}>
          Clear filters
        </Button>
      )}
    </form>
  );
}
