import { useRef, useState, type KeyboardEvent } from 'react';
import {
  createCanonicalEntity,
  updateCanonicalEntity,
  type CanonicalEntity,
} from '../../api/client';
import Button from '../../components/ui/Button';
import Dialog from '../../components/ui/Dialog';
import Field from '../../components/ui/Field';
import Textarea from '../../components/ui/Textarea';
import { notify } from '../../components/ui/toast';
import { useFormSubmit } from '../../lib/use-form-submit';

function aliasesToText(aliases?: string[]): string {
  return (aliases ?? []).join('\n');
}

// One alias per line, trimmed, blank lines dropped — the textarea never sends an empty string as
// a registered alias.
function parseAliases(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Lines that repeat an earlier line, matched case-insensitively — the registry's uniqueness is on
// the normalized alias, not the raw text an operator typed.
function findDuplicateAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const alias of aliases) {
    const key = alias.toLowerCase();
    if (seen.has(key)) {
      duplicates.push(alias);
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

type FieldName = 'canonicalName' | 'aliases';

interface EntityEditorDialogProps {
  // Absent means this is a create — the dialog carries no separate "mode" flag beyond this.
  entity?: CanonicalEntity;
  onClose: () => void;
  onSaved: (entity: CanonicalEntity) => void;
}

/** Create/edit authoring surface for one canonical entity, always open — its parent mounts it
 * only while creating or editing, so each open is a fresh instance with fresh state and there is
 * no `open` prop to thread through. */
export default function EntityEditorDialog({ entity, onClose, onSaved }: EntityEditorDialogProps) {
  const [canonicalName, setCanonicalName] = useState(entity?.canonicalName ?? '');
  const [aliasesText, setAliasesText] = useState(() => aliasesToText(entity?.aliases));
  const formRef = useRef<HTMLFormElement>(null);

  function validate(): Partial<Record<FieldName, string>> {
    const errors: Partial<Record<FieldName, string>> = {};
    if (!canonicalName.trim()) {
      errors.canonicalName = 'Canonical name is required.';
    }
    const duplicates = findDuplicateAliases(parseAliases(aliasesText));
    if (duplicates.length > 0) {
      errors.aliases = `Aliases repeat: ${duplicates.join(', ')}`;
    }
    return errors;
  }

  async function submit() {
    const aliases = parseAliases(aliasesText);
    const trimmedName = canonicalName.trim();
    const saved = entity
      ? await updateCanonicalEntity(entity.id, { canonicalName: trimmedName, aliases })
      : await createCanonicalEntity({ canonicalName: trimmedName, aliases });
    notify(
      'success',
      entity ? `Saved changes to "${saved.canonicalName}".` : `Added "${saved.canonicalName}".`,
    );
    onSaved(saved);
  }

  const { pending, formError, onSubmit, fieldProps } = useFormSubmit<FieldName>({
    validate,
    submit,
  });
  const { id: nameId, error: nameError, onBlur: nameBlur } = fieldProps('canonicalName');
  const { id: aliasesId, error: aliasesError, onBlur: aliasesBlur } = fieldProps('aliases');

  // A single-line field submits on Enter in every real browser as its own default action; jsdom's
  // test environment does not implement that implicit submission, so this makes it explicit
  // instead of relying on it. The aliases textarea gets no such handler — Enter there must insert
  // a newline, since one alias per line is the entry model.
  function handleNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={entity ? `Edit "${entity.canonicalName}"` : 'Add alias group'}
      size="md"
    >
      <form ref={formRef} onSubmit={onSubmit} className="form" noValidate>
        <Field id={nameId} label="Canonical name" error={nameError}>
          {(inputProps) => (
            <input
              type="text"
              value={canonicalName}
              onChange={(e) => setCanonicalName(e.target.value)}
              onBlur={nameBlur}
              onKeyDown={handleNameKeyDown}
              placeholder="Northgate Plaza"
              disabled={pending}
              {...inputProps}
            />
          )}
        </Field>
        <Textarea
          id={aliasesId}
          label="Aliases"
          optional
          hint="One alias per line. Blank lines are ignored."
          error={aliasesError}
          rows={5}
          value={aliasesText}
          onChange={setAliasesText}
          onBlur={aliasesBlur}
          placeholder={'Northgate\nNorthgate Shopping Center'}
          disabled={pending}
        />

        {formError && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}

        <div className="form-actions">
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? (entity ? 'Saving…' : 'Adding…') : entity ? 'Save changes' : 'Add entity'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
