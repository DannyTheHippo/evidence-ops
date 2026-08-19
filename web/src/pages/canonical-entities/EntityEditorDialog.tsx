import { useState } from 'react';
import {
  createCanonicalEntity,
  updateCanonicalEntity,
  type CanonicalEntity,
} from '../../api/client';
import Button from '../../components/ui/Button';
import Dialog from '../../components/ui/Dialog';
import Field from '../../components/ui/Field';
import { notify } from '../../components/ui/toast';

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

interface EntityEditorDialogProps {
  // Absent means this is a create — the dialog carries no separate "mode" flag beyond this.
  entity?: CanonicalEntity;
  onClose: () => void;
  onSaved: (entity: CanonicalEntity) => void;
}

/** Create/edit authoring surface for one canonical entity, always open — its parent mounts it
 * only while creating or editing, so each open is a fresh instance with fresh state and there is
 * no `open` prop to thread through, matching `RuleEditorDialog`. */
export default function EntityEditorDialog({ entity, onClose, onSaved }: EntityEditorDialogProps) {
  const [canonicalName, setCanonicalName] = useState(entity?.canonicalName ?? '');
  const [aliasesText, setAliasesText] = useState(() => aliasesToText(entity?.aliases));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    const aliases = parseAliases(aliasesText);
    try {
      const saved = entity
        ? await updateCanonicalEntity(entity.id, { canonicalName: canonicalName.trim(), aliases })
        : await createCanonicalEntity({ canonicalName: canonicalName.trim(), aliases });
      notify(
        'success',
        entity ? `Saved changes to "${saved.canonicalName}".` : `Added "${saved.canonicalName}".`,
      );
      onSaved(saved);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save canonical entity');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={entity ? `Edit "${entity.canonicalName}"` : 'Add canonical entity'}
    >
      <div className="form">
        <Field label="Canonical name">
          {(inputProps) => (
            <input
              type="text"
              required
              value={canonicalName}
              onChange={(e) => setCanonicalName(e.target.value)}
              placeholder="Northgate Plaza"
              {...inputProps}
            />
          )}
        </Field>
        <Field label="Aliases" hint="One alias per line. Blank lines are ignored.">
          {(inputProps) => (
            <textarea
              rows={5}
              value={aliasesText}
              onChange={(e) => setAliasesText(e.target.value)}
              placeholder={'Northgate\nNorthgate Shopping Center'}
              {...inputProps}
            />
          )}
        </Field>
      </div>

      {saveError && (
        <p className="error" role="alert">
          {saveError}
        </p>
      )}

      <div className="form-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void handleSave()}>
          {saving ? (entity ? 'Saving…' : 'Adding…') : entity ? 'Save changes' : 'Add entity'}
        </Button>
      </div>
    </Dialog>
  );
}
