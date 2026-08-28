import type { FormEvent, ReactNode } from 'react';
import Button from './Button';

interface FilterBarProps {
  children: ReactNode;
  onApply: () => void;
  onClear: () => void;
  hasFilter: boolean;
}

/** Submit-on-Apply filter form: wraps `Select`/`Field` controls the caller renders as `children`
 * and fires `onApply` only when the form is submitted, never on a child's own `onChange` — a
 * filtered list stays shareable and reloadable through its URL instead of firing a request per
 * keystroke. The page owns every filter's current and applied value; this component owns none of
 * it, so `onApply` and `onClear` both take no arguments. `Clear filters` calls `onClear` and is
 * only rendered while `hasFilter` is true, matching the "nothing to clear" state. */
export default function FilterBar({ children, onApply, onClear, hasFilter }: FilterBarProps) {
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onApply();
  }

  return (
    <form onSubmit={handleSubmit} className="control-row">
      {children}
      <Button type="submit" variant="primary">
        Apply filters
      </Button>
      {hasFilter && (
        <Button type="button" variant="ghost" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </form>
  );
}
