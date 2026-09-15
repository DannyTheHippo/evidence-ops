import type { RadioOption } from '../components/ui/RadioGroup';
import type { DocumentSourceClass, SourceKind } from '../api/client';

/** Connectivity choices for the New source dialog's `RadioGroup`. */
export const CONNECTIVITY_OPTIONS: RadioOption[] = [
  {
    value: 'connector',
    label: 'Connector',
    hint: 'This system syncs bytes directly from the source.',
  },
  {
    value: 'export-only',
    label: 'Export-only',
    hint: 'Someone exports files by hand; this system only reads what lands.',
  },
  {
    value: 'manual',
    label: 'Manual',
    hint: 'Nothing syncs automatically — catalogued by hand only.',
  },
];

/** Reachability choices for the New source dialog's `RadioGroup`. */
export const REACHABILITY_OPTIONS: RadioOption[] = [
  { value: 'live', label: 'Live', hint: 'This system can reach the source right now.' },
  {
    value: 'possible',
    label: 'Possible',
    hint: 'Reachable in principle, but access is not yet set up.',
  },
  {
    value: 'prohibited',
    label: 'Prohibited',
    hint: 'Policy blocks this system from reaching the source.',
  },
];

/** Tracked choices for the New source dialog's `RadioGroup`. */
export const TRACKED_OPTIONS: RadioOption[] = [
  {
    value: 'true',
    label: 'Synced by a connector',
    hint: 'The sync loop may run for this source.',
  },
  {
    value: 'false',
    label: 'Catalogued only',
    hint: 'An inventory record only — the sync loop never runs for it.',
  },
];

/** Every `DocumentSourceClass` the server can send, forced to a label — a future member fails
 * this file to compile rather than rendering unlabelled. */
const CLASS_LABELS: Record<DocumentSourceClass, string> = {
  'crm-export': 'CRM export',
  'pm-export': 'PM export',
  spreadsheet: 'Spreadsheet',
  memo: 'Memo',
  report: 'Report',
  unclassified: 'Unclassified',
};

/** Class choices for the New source dialog's `Select`, in `CLASS_LABELS`' key order. */
export const CLASS_OPTIONS: { value: DocumentSourceClass; label: string }[] = (
  Object.entries(CLASS_LABELS) as [DocumentSourceClass, string][]
).map(([value, label]) => ({ value, label }));

/** Every `SourceKind` the server can send, forced to a label — a future member fails this file to
 * compile rather than rendering unlabelled. */
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  'local-folder': 'Local folder',
  'mcp-submit': 'MCP submission',
};

/** The label a reader sees for a source's class, falling back to the raw value for a class this
 * SPA build does not yet know how to label. */
export function sourceClassLabel(value: DocumentSourceClass): string {
  return CLASS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
