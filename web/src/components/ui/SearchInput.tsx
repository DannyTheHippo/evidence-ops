import { useRef, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import Field from './Field';
import IconButton from './IconButton';
import { IconX } from '../icons';

interface SearchInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'width'
> {
  label: string;
  hint?: string;
  error?: string;
  width?: 'sm' | 'md' | 'lg' | 'grow' | 'full';
  value: string;
  onChange: (value: string) => void;
  /** Fires on Enter and on the clear control, both applying the value at once rather than through
   * a form submit — `FilterBar` has no submit button, and Enter's own implicit submission needs
   * exactly one blocking field in the form to fire at all. The clear control calls `onChange('')`
   * and then `onSearch('')` in the same handler, before a re-render. */
  onSearch?: (value: string) => void;
}

/** Labelled `type="search"` input, composed on `Field` exactly as `Input` is — including the
 * `width`-forwarding shape `@types/react`'s `InputHTMLAttributes` forces on every field control.
 * The wrapper carries `role="search"`; a clear control appears only once there is a value to clear
 * and returns focus to the input rather than dropping it to the document body. No global key is
 * bound — `/` stays free. */
export default function SearchInput({
  id,
  label,
  hint,
  error,
  width,
  value,
  onChange,
  onSearch,
  onKeyDown,
  'aria-describedby': describedBy,
  ...rest
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(e);
    if (e.key === 'Enter') onSearch?.(value);
  }

  function handleClear() {
    onChange('');
    onSearch?.('');
    inputRef.current?.focus();
  }

  return (
    <Field id={id} label={label} hint={hint} error={error} describedBy={describedBy} width={width}>
      {(inputProps) => (
        <div className="search-input" role="search">
          <input
            {...rest}
            {...inputProps}
            ref={inputRef}
            type="search"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {value !== '' && (
            <IconButton
              icon={<IconX />}
              aria-label="Clear search"
              variant="ghost"
              size="sm"
              className="search-input-clear"
              onClick={handleClear}
            />
          )}
        </div>
      )}
    </Field>
  );
}
