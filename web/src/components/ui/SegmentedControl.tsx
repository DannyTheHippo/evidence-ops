import Button from './Button';

interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the button group for a screen reader — there is no visible group label of its own. */
  'aria-label': string;
}

/** A button-pair (or wider) switch driving URL state, not a tabpanel: plain buttons carrying
 * `aria-pressed`, in normal tab order, rather than ARIA tabs — `role="tablist"` implies exactly
 * one associated `tabpanel`, which none of this control's callers have. An option's `count`
 * renders `aria-hidden` so the button's accessible name stays just its `label`, unaffected by a
 * count that changes as the underlying list does. */
export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div className="control-row" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant={option.value === value ? 'primary' : 'secondary'}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span aria-hidden="true"> ({option.count})</span>}
        </Button>
      ))}
    </div>
  );
}
