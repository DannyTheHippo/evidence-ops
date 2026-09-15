import { useId, useState, type KeyboardEvent } from 'react';
import Field from './Field';

export interface ComboboxOption {
  value: string;
  label: string;
}

interface ComboboxProps {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  /** Caps the wrapper's width via `Field`'s modifier class; forwarded, never spread onto the
   * input. See `Input`'s equivalent prop. */
  width?: 'sm' | 'md' | 'lg' | 'full';
  options: ComboboxOption[];
  /** Single-value mode. Exactly one of `value`/`values` is supplied. */
  value?: string;
  onChange?: (value: string) => void;
  /** Multi-value chips mode. */
  values?: string[];
  onValuesChange?: (values: string[]) => void;
  placeholder?: string;
  /** Overrides the internally generated id, flowing through `Field` as `Input` does. */
  id?: string;
  name?: string;
  onBlur?: () => void;
}

/** Labelled combobox following the ARIA 1.2 combobox pattern with a native-listbox popup: the
 * text input carries `role="combobox"`/`aria-expanded`/`aria-controls`/`aria-activedescendant`
 * and keeps DOM focus throughout, while the option the arrow keys have moved to is only ever
 * referenced by `aria-activedescendant` — no roving `tabIndex` on the options themselves. Typing
 * filters `options` by label. `values`/`onValuesChange` selects the multi-value mode, rendering
 * selected options as removable chips above the input rather than committing `onChange`; a chip
 * is a single `<button>` whose accessible name is `Remove <label>` via `aria-label`, overriding
 * its visible text. Composed on `Field` for the label/hint/error/`aria-describedby` plumbing
 * shared with every other labelled control. */
export default function Combobox({
  label,
  hint,
  error,
  optional,
  width,
  options,
  value,
  onChange,
  values,
  onValuesChange,
  placeholder,
  id,
  name,
  onBlur,
}: ComboboxProps) {
  const isMulti = values !== undefined;
  const selectedOption = !isMulti ? options.find((option) => option.value === value) : undefined;

  const [query, setQuery] = useState(selectedOption?.label ?? '');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listboxId = useId();

  // Keeps the input's text synced to the selected option's label whenever the caller changes
  // `value` from outside while the list is closed; open, the text is the user's own query. Adjusted
  // during render rather than in an effect: the check is a no-op once `query` already matches, so
  // it converges in the same extra pass React grants a render-phase `setState` call.
  const selectedLabel = selectedOption?.label ?? '';
  if (!open && query !== selectedLabel) {
    setQuery(selectedLabel);
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = options.filter((option) => {
    if (isMulti && values.includes(option.value)) return false;
    return normalizedQuery === '' || option.label.toLowerCase().includes(normalizedQuery);
  });

  const activeOption = activeIndex >= 0 ? filteredOptions[activeIndex] : undefined;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  function openList() {
    setOpen(true);
    setActiveIndex(0);
  }

  function closeList() {
    setOpen(false);
    setActiveIndex(-1);
  }

  function commit(option: ComboboxOption) {
    if (isMulti) {
      onValuesChange?.([...values, option.value]);
      setQuery('');
    } else {
      onChange?.(option.value);
      setQuery(option.label);
    }
    closeList();
  }

  function removeChip(chipValue: string) {
    onValuesChange?.(values?.filter((v) => v !== chipValue) ?? []);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const lastIndex = filteredOptions.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) {
          openList();
          break;
        }
        setActiveIndex((index) => (index + 1) % Math.max(filteredOptions.length, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (!open) {
          openList();
          break;
        }
        setActiveIndex(
          (index) => (index - 1 + filteredOptions.length) % Math.max(filteredOptions.length, 1),
        );
        break;
      case 'Home':
        if (!open) break;
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        if (!open) break;
        event.preventDefault();
        setActiveIndex(lastIndex);
        break;
      case 'Enter':
        if (open && activeOption) {
          event.preventDefault();
          commit(activeOption);
        }
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          closeList();
        }
        break;
      case 'Backspace':
        if (isMulti && query === '' && values.length > 0) {
          removeChip(values[values.length - 1]);
        }
        break;
      default:
        break;
    }
  }

  return (
    <Field id={id} label={label} hint={hint} error={error} optional={optional} width={width}>
      {(inputProps) => (
        <div className="combobox">
          {isMulti && values.length > 0 && (
            <div className="combobox-chips">
              {values.map((chipValue) => {
                const chipLabel =
                  options.find((option) => option.value === chipValue)?.label ?? chipValue;
                return (
                  <button
                    key={chipValue}
                    type="button"
                    className="combobox-chip"
                    aria-label={`Remove ${chipLabel}`}
                    onClick={() => removeChip(chipValue)}
                  >
                    {chipLabel}
                  </button>
                );
              })}
            </div>
          )}
          <input
            {...inputProps}
            type="text"
            name={name}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={activeOption ? optionId(activeIndex) : undefined}
            autoComplete="off"
            placeholder={placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              openList();
            }}
            onFocus={openList}
            onBlur={() => {
              closeList();
              onBlur?.();
            }}
            onKeyDown={handleKeyDown}
          />
          {open && (
            <ul className="combobox-listbox" role="listbox" id={listboxId}>
              {filteredOptions.map((option, index) => (
                <li
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={
                    index === activeIndex
                      ? 'combobox-option combobox-option--active'
                      : 'combobox-option'
                  }
                  onMouseDown={(event) => {
                    event.preventDefault();
                    commit(option);
                  }}
                >
                  {option.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Field>
  );
}
