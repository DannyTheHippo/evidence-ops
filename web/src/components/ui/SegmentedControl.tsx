import { Fragment, useId } from 'react';
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
 * renders `aria-hidden` inline so the button's accessible name stays just its `label`, unaffected
 * by a count that changes as the underlying list does; a paired `.sr-only` span, reached through
 * `aria-describedby`, still exposes it to assistive technology as a description rather than
 * dropping it entirely. */
export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  const baseId = useId();
  return (
    <div className="segmented-control" role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const countId = option.count !== undefined ? `${baseId}-${option.value}-count` : undefined;
        return (
          <Fragment key={option.value}>
            <Button
              type="button"
              variant={option.value === value ? 'primary' : 'secondary'}
              aria-pressed={option.value === value}
              aria-describedby={countId}
              onClick={() => onChange(option.value)}
            >
              <span className="btn-label">{option.label}</span>
              {option.count !== undefined && <span aria-hidden="true"> ({option.count})</span>}
            </Button>
            {countId && (
              <span id={countId} className="sr-only">
                {option.count} items
              </span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
