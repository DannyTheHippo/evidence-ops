import { useState } from 'react';
import { confirmMeasure, updateMeasure, type Measure, type MeasureEdits } from '../../api/client';
import Button from '../../components/ui/Button';
import Dialog from '../../components/ui/Dialog';
import ErrorSummary from '../../components/ui/ErrorSummary';
import Input from '../../components/ui/Input';
import Select from '../../components/ui/Select';
import Textarea from '../../components/ui/Textarea';
import { useFormSubmit } from '../../lib/use-form-submit';

function aliasesToText(aliases: string[]): string {
  return aliases.join('\n');
}

// One alias per line, trimmed, blank lines dropped — the textarea never sends an empty string as
// a registered alias.
function parseAliases(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const VALUE_TYPE_OPTIONS: { value: Measure['valueType']; label: string }[] = [
  { value: 'currency', label: 'Currency' },
  { value: 'percentage', label: 'Percentage' },
  { value: 'area', label: 'Area' },
  { value: 'duration', label: 'Duration' },
  { value: 'count', label: 'Count' },
];

const TOLERANCE_KIND_OPTIONS: { value: Measure['toleranceKind']; label: string }[] = [
  { value: 'absolute', label: 'Absolute' },
  { value: 'relative', label: 'Relative' },
];

type FieldName =
  | 'label'
  | 'aliases'
  | 'valueType'
  | 'canonicalUnit'
  | 'toleranceKind'
  | 'tolerance'
  | 'stalenessWindowMs';

interface MeasureEditorDialogProps {
  measure: Measure;
  mode: 'confirm' | 'edit';
  onClose: () => void;
  onSaved: (measure: Measure) => void;
}

/** Confirm/edit authoring surface for one measure, always open — its parent mounts it only while
 * confirming or editing a measure, so each open is a fresh instance with fresh state prefilled
 * from `measure`. Confirming a proposed measure authorizes fact extraction to mint facts under it
 * tenant-wide; editing a confirmed measure's definition changes how every fact under it, past and
 * future, is interpreted. Both bump the measure's version and trigger a synchronous rescan of
 * every fact it already stamped for conflicts, which is why the form states that consequence
 * rather than presenting either action as a neutral toggle. */
export default function MeasureEditorDialog({
  measure,
  mode,
  onClose,
  onSaved,
}: MeasureEditorDialogProps) {
  const [label, setLabel] = useState(measure.label);
  const [aliasesText, setAliasesText] = useState(() => aliasesToText(measure.aliases));
  const [valueType, setValueType] = useState<Measure['valueType']>(measure.valueType);
  const [canonicalUnit, setCanonicalUnit] = useState(measure.canonicalUnit);
  const [toleranceKind, setToleranceKind] = useState<Measure['toleranceKind']>(
    measure.toleranceKind,
  );
  const [tolerance, setTolerance] = useState(String(measure.tolerance));
  const [stalenessWindowMs, setStalenessWindowMs] = useState(
    measure.stalenessWindowMs !== undefined ? String(measure.stalenessWindowMs) : '',
  );

  function validate(): Partial<Record<FieldName, string>> {
    const errors: Partial<Record<FieldName, string>> = {};
    if (!label.trim()) errors.label = 'Label is required.';
    if (!canonicalUnit.trim()) errors.canonicalUnit = 'Canonical unit is required.';
    const parsedTolerance = Number(tolerance);
    if (!tolerance.trim() || !Number.isFinite(parsedTolerance) || parsedTolerance < 0) {
      errors.tolerance = 'Enter a tolerance of zero or greater.';
    }
    return errors;
  }

  async function submit() {
    const edits: MeasureEdits = {
      label: label.trim(),
      aliases: parseAliases(aliasesText),
      valueType,
      canonicalUnit: canonicalUnit.trim(),
      toleranceKind,
      tolerance: Number(tolerance),
      stalenessWindowMs: stalenessWindowMs.trim() ? Number(stalenessWindowMs) : undefined,
    };
    const saved =
      mode === 'confirm'
        ? await confirmMeasure(measure.id, edits)
        : await updateMeasure(measure.id, edits);
    onSaved(saved);
  }

  const {
    pending,
    formError,
    onSubmit,
    fieldProps,
    summary: { ref: summaryRef, errors: summaryErrors },
  } = useFormSubmit<FieldName>({ validate, submit });

  // Called in the form's visual order — see SourcesPage.tsx's CreateSourceDialog for why this
  // order matters to the summary/focus-on-failure walk.
  const labelField = fieldProps('label');
  const aliasesField = fieldProps('aliases');
  const valueTypeField = fieldProps('valueType');
  const canonicalUnitField = fieldProps('canonicalUnit');
  const toleranceKindField = fieldProps('toleranceKind');
  const toleranceField = fieldProps('tolerance');
  const stalenessWindowMsField = fieldProps('stalenessWindowMs');

  const confirmLabel = mode === 'confirm' ? 'Confirm measure' : 'Save changes';

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'confirm' ? `Confirm "${measure.label}"` : `Edit "${measure.label}"`}
      size="md"
    >
      <form onSubmit={onSubmit} className="form" noValidate>
        <ErrorSummary ref={summaryRef} errors={summaryErrors} formError={formError ?? undefined} />
        <p className="cell-sub">
          {mode === 'confirm'
            ? 'Confirming this measure authorizes fact extraction under it, bumps its version, and rescans every fact it already stamped for conflicts.'
            : "Saving changes bumps this measure's version and rescans every fact under it for conflicts."}
        </p>
        <Input {...labelField} label="Label" value={label} onChange={setLabel} disabled={pending} />
        <Textarea
          {...aliasesField}
          label="Aliases"
          optional
          hint="One alias per line. Blank lines are ignored."
          rows={4}
          value={aliasesText}
          onChange={setAliasesText}
          disabled={pending}
        />
        <Select
          {...valueTypeField}
          label="Value type"
          options={VALUE_TYPE_OPTIONS}
          value={valueType}
          onChange={(next) => setValueType(next as Measure['valueType'])}
          disabled={pending}
        />
        <Input
          {...canonicalUnitField}
          label="Canonical unit"
          value={canonicalUnit}
          onChange={setCanonicalUnit}
          disabled={pending}
        />
        <Select
          {...toleranceKindField}
          label="Tolerance kind"
          options={TOLERANCE_KIND_OPTIONS}
          value={toleranceKind}
          onChange={(next) => setToleranceKind(next as Measure['toleranceKind'])}
          disabled={pending}
        />
        <Input
          {...toleranceField}
          label="Tolerance"
          type="number"
          min={0}
          value={tolerance}
          onChange={setTolerance}
          disabled={pending}
        />
        <Input
          {...stalenessWindowMsField}
          label="Staleness window (ms)"
          optional
          type="number"
          min={0}
          value={stalenessWindowMs}
          onChange={setStalenessWindowMs}
          disabled={pending}
        />
        <div className="form-actions">
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
