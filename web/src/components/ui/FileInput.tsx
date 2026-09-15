import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FocusEventHandler,
} from 'react';
import { formatBytes } from '../../lib/format-size';
import IconButton from './IconButton';
import { IconX } from '../icons';

export interface FileInputFile {
  file: File;
  error?: string;
}

interface FileInputProps {
  /** Overrides the internally generated id for the drop zone's `<label htmlFor>`, the file
   * input's own `id`, and the derived hint/error ids — the same override `Field` supports, so a
   * form can bind this control to a stable id and focus it by that id on a failed submit. */
  id?: string;
  name?: string;
  label: string;
  hint?: string;
  error?: string;
  /** Appends an "(optional)" suffix inside the drop zone's label, so it stays part of the
   * control's accessible name rather than sitting beside it unannounced. */
  optional?: boolean;
  /** Caps the wrapper's width via a modifier class; defaults to `'full'`, which adds none. */
  width?: 'sm' | 'md' | 'lg' | 'full';
  /** Extension allowlist, for example `UPLOAD_ACCEPT` from `lib/upload-accept.ts`. Not enforced
   * on dropped files; the caller prechecks every added file. */
  accept: string;
  multiple?: boolean;
  files: FileInputFile[];
  onFilesAdded: (files: File[]) => void;
  onFileRemoved: (index: number) => void;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  disabled?: boolean;
}

/** Drop zone plus a real `<input type="file">`, the zone itself the input's `<label>` so Enter and
 * Space open the native picker from the keyboard exactly as they would on a bare file input. The
 * input is never `required` and its value is cleared after every selection, so picking the same
 * file twice still fires a change. Drag state is a counter rather than a boolean: a `dragenter` on
 * a child inside the zone always arrives before the matching `dragleave` on the zone itself, so the
 * counter never reaches zero — and never flickers the dragging class off — for a pointer that is
 * still inside the zone. The caller owns the queued `files` list and any per-file validation; this
 * component only reports what was added or removed. `id`, `name`, `error` and `onBlur` give it the
 * same binding surface as `Field`'s other consumers, so a form can register it, show a server field
 * error against it, and move focus to it — the sr-only input is the focusable target `id` names. */
export default function FileInput({
  id: idProp,
  name,
  label,
  hint,
  error,
  optional,
  width = 'full',
  accept,
  multiple,
  files,
  onFilesAdded,
  onFileRemoved,
  onBlur,
  disabled,
}: FileInputProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const labelId = `${id}-label`;
  const instructionId = `${id}-instruction`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [instructionId, hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;
  const dragCounter = useRef(0);
  const [dragging, setDragging] = useState(false);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    onFilesAdded(Array.from(e.target.files ?? []));
    e.target.value = '';
  }

  function handleDragEnter(e: DragEvent<HTMLLabelElement>) {
    if (disabled) return;
    e.preventDefault();
    dragCounter.current += 1;
    setDragging(true);
  }

  function handleDragOver(e: DragEvent<HTMLLabelElement>) {
    if (disabled) return;
    e.preventDefault();
  }

  function handleDragLeave(e: DragEvent<HTMLLabelElement>) {
    if (disabled) return;
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLLabelElement>) {
    if (disabled) return;
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    onFilesAdded(Array.from(e.dataTransfer.files));
  }

  return (
    <div className={width === 'full' ? 'field' : `field field--${width}`}>
      <label
        htmlFor={id}
        className={['file-input', dragging ? 'file-input--dragging' : null]
          .filter(Boolean)
          .join(' ')}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span id={labelId} className="field-label">
          {label}
          {optional && (
            <>
              {' '}
              <span className="field-optional">(optional)</span>
            </>
          )}
        </span>
        <span id={instructionId}>Drag files here, or press Enter to browse</span>
        <input
          id={id}
          name={name}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={handleChange}
          onBlur={onBlur}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className="sr-only"
        />
      </label>
      {hint && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
      {error && (
        <p id={errorId} className="field-error">
          <span className="sr-only">Error: </span>
          {error}
        </p>
      )}
      {files.length > 0 && (
        <ul className="file-input-list" role="list">
          {files.map((entry, index) => (
            <li className="file-input-row" key={`${entry.file.name}-${index}`}>
              <span>{entry.file.name}</span>
              <span className="file-input-row-size">{formatBytes(entry.file.size)}</span>
              {entry.error && <span className="field-error">{entry.error}</span>}
              <IconButton
                icon={<IconX />}
                aria-label={`Remove ${entry.file.name}`}
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => onFileRemoved(index)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
