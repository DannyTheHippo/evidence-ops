import { useId, useState } from 'react';
import Field from './Field';
import Select from './Select';
import { DATE_RANGE_OPTIONS, isCompleteDate, type DateRangeValue } from '../../lib/date-range';

interface DateRangeProps {
  /** Visible label of the range select; it also names the group. */
  label: string;
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  /** The range select's id, which also prefixes its label id as `${id}-label` and the two date
   * `Field` ids as `${id}-from`/`${id}-to`. Generated when absent. */
  id?: string;
  /** The range select's name, which also prefixes the two date input names as
   * `${name}-from`/`${name}-to`. */
  name?: string;
  /** Shown under the From input while it holds no ordering error. */
  hint?: string;
  /** Marks both date inputs invalid and describes them with the text, unless an edit just inverted
   * the range — that ordering error then takes precedence on whichever input caused it. */
  error?: string;
  /** Forwarded to both date inputs. */
  onBlur?: () => void;
}

const ORDER_ERROR = 'From must be on or before To.';

/** Date-range filter: a `div[role=group]` named by the range select's visible label, holding one
 * `Select` over `DATE_RANGE_OPTIONS`. Any time or a preset emits that key with both dates `''`;
 * Custom range emits `custom` with the current dates and focus stays on the select. While the
 * value is custom, From and To `type="date"` inputs composed on `Field` follow the select.
 *
 * Each date input keeps its own local draft, because a browser's `type="date"` input can emit an
 * intermediate value while a year is still being typed (`0002-09-01`), and writing that straight
 * through would round-trip as `''` and wipe the whole field. A keystroke reaches `onChange` only
 * once its own input reads as a complete calendar date (`isCompleteDate`); until then the draft
 * stays local and the other bound falls back to its current `value`. Both drafts re-sync from
 * `value` whenever its range, from, or to changes from outside the component — Clear, a preset, or
 * a deep link — so a draft never resurfaces once the operator leaves and re-enters Custom range. A
 * pair where From reads after To is never emitted either — the URL keeps its last valid custom
 * range — and the ordering error lands on whichever input's edit caused the inversion, marking
 * that input invalid in place of the caller's `error`, which otherwise marks both inputs
 * invalid. */
export default function DateRange({
  label,
  value,
  onChange,
  id,
  name,
  hint,
  error,
  onBlur,
}: DateRangeProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  const [fromDraft, setFromDraft] = useState(value.from);
  const [toDraft, setToDraft] = useState(value.to);
  // The field the operator last typed into. Read only while `orderError` is true, so the error
  // attaches to whichever field's edit produced the inversion rather than always to To — reset
  // alongside the drafts below, since a resync means the current inversion, if any, came from an
  // external change rather than a keystroke.
  const [invertedBy, setInvertedBy] = useState<'from' | 'to' | null>(null);
  const [prev, setPrev] = useState({ range: value.range, from: value.from, to: value.to });
  if (value.range !== prev.range || value.from !== prev.from || value.to !== prev.to) {
    setPrev({ range: value.range, from: value.from, to: value.to });
    setFromDraft(value.from);
    setToDraft(value.to);
    setInvertedBy(null);
  }

  const orderError =
    fromDraft !== '' &&
    toDraft !== '' &&
    isCompleteDate(fromDraft) &&
    isCompleteDate(toDraft) &&
    fromDraft > toDraft;
  const orderErrorField = orderError ? (invertedBy ?? 'to') : null;

  function commit(nextFromDraft: string, nextToDraft: string) {
    const from = isCompleteDate(nextFromDraft) ? nextFromDraft : value.from;
    const to = isCompleteDate(nextToDraft) ? nextToDraft : value.to;
    if (from !== '' && to !== '' && from > to) return;
    if (from !== value.from || to !== value.to) onChange({ range: 'custom', from, to });
  }

  function handleRangeChange(next: string) {
    const range = DATE_RANGE_OPTIONS.find((option) => option.value === next)?.value ?? '';
    onChange(
      range === 'custom' ? { range, from: value.from, to: value.to } : { range, from: '', to: '' },
    );
  }

  function handleFromChange(next: string) {
    setFromDraft(next);
    setInvertedBy('from');
    commit(next, toDraft);
  }

  function handleToChange(next: string) {
    setToDraft(next);
    setInvertedBy('to');
    commit(fromDraft, next);
  }

  return (
    <div className="date-range" role="group" aria-labelledby={`${selectId}-label`}>
      <Select
        id={selectId}
        name={name}
        label={label}
        options={[...DATE_RANGE_OPTIONS]}
        value={value.range}
        onChange={handleRangeChange}
      />
      {value.range === 'custom' && (
        <div className="date-range-row">
          <Field
            id={`${selectId}-from`}
            label="From"
            hint={orderErrorField ? undefined : hint}
            error={orderErrorField === 'from' ? ORDER_ERROR : error}
          >
            {(inputProps) => (
              <input
                {...inputProps}
                type="date"
                name={name ? `${name}-from` : undefined}
                value={fromDraft}
                onChange={(e) => handleFromChange(e.target.value)}
                onBlur={onBlur}
              />
            )}
          </Field>
          <Field
            id={`${selectId}-to`}
            label="To"
            error={orderErrorField === 'to' ? ORDER_ERROR : error}
          >
            {(inputProps) => (
              <input
                {...inputProps}
                type="date"
                name={name ? `${name}-to` : undefined}
                value={toDraft}
                onChange={(e) => handleToChange(e.target.value)}
                onBlur={onBlur}
              />
            )}
          </Field>
        </div>
      )}
    </div>
  );
}
