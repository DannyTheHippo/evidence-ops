import { CANARY_MARKERS, SEEDED_CONFLICT, SEEDED_NOI_CONFLICT } from './constants';
import { sha256Hex } from './hash';
import type { DocxParagraphManifest } from './build-lease-summary';
import type { SheetManifest } from './build-comps-sheet';

export interface XlsxConflictLocation {
  file: string;
  sheet: string;
  cell: string;
  value: number;
  display: string;
}

export interface PdfConflictLocation {
  file: string;
  page: number;
  display: string;
  context: string;
}

export type ConflictLocation = XlsxConflictLocation | PdfConflictLocation;

export interface ConflictRecord {
  id: string;
  property: string;
  locations: ConflictLocation[];
  note: string;
}

export interface DataRoomManifest {
  generatedAt: string;
  files: {
    'comps.xlsx': { sha256: string; sheets: SheetManifest[] };
    'noi-summary.csv': { sha256: string; sheets: SheetManifest[] };
    'valuation-memo.pdf': { sha256: string; pageCount: number };
    'market-overview.pdf': { sha256: string; pageCount: number };
    'lease-summary.docx': { sha256: string; paragraphs: DocxParagraphManifest[] };
  };
  /**
   * One record per seeded cross-source conflict. An array rather than a single field because the
   * corpus now seeds more than one: `SEEDED_CONFLICT` (cap rate, spreadsheet vs. prose) at index
   * 0, `SEEDED_NOI_CONFLICT` (net operating income, spreadsheet vs. delimited text) at index 1 —
   * both order and count are fixed by this function, never data-dependent.
   */
  conflicts: ConflictRecord[];
  canaries: Array<{
    id: string;
    token: string;
    file: string;
    location: Record<string, unknown>;
    description: string;
  }>;
}

export interface ManifestInputs {
  comps: { buffer: Buffer; sheet: SheetManifest };
  noiSummaryCsv: { buffer: Buffer; sheet: SheetManifest };
  valuationMemo: { buffer: Buffer; pageCount: number };
  marketOverview: { buffer: Buffer; pageCount: number };
  leaseSummary: { buffer: Buffer; paragraphs: DocxParagraphManifest[] };
}

// Fixed rather than `new Date().toISOString()` — the manifest is committed alongside the
// binaries it describes and must not drift on every regeneration when nothing else changed.
const MANIFEST_GENERATED_AT = '2026-01-01T00:00:00.000Z';

export function buildManifest(inputs: ManifestInputs): DataRoomManifest {
  return {
    generatedAt: MANIFEST_GENERATED_AT,
    files: {
      'comps.xlsx': {
        sha256: sha256Hex(inputs.comps.buffer),
        sheets: [inputs.comps.sheet],
      },
      'noi-summary.csv': {
        sha256: sha256Hex(inputs.noiSummaryCsv.buffer),
        sheets: [inputs.noiSummaryCsv.sheet],
      },
      'valuation-memo.pdf': {
        sha256: sha256Hex(inputs.valuationMemo.buffer),
        pageCount: inputs.valuationMemo.pageCount,
      },
      'market-overview.pdf': {
        sha256: sha256Hex(inputs.marketOverview.buffer),
        pageCount: inputs.marketOverview.pageCount,
      },
      'lease-summary.docx': {
        sha256: sha256Hex(inputs.leaseSummary.buffer),
        paragraphs: inputs.leaseSummary.paragraphs,
      },
    },
    conflicts: [
      {
        id: SEEDED_CONFLICT.id,
        property: SEEDED_CONFLICT.property,
        locations: [
          {
            file: 'comps.xlsx',
            sheet: 'Comps',
            cell: 'F2',
            value: SEEDED_CONFLICT.sheetValue.raw,
            display: SEEDED_CONFLICT.sheetValue.display,
          },
          {
            file: 'valuation-memo.pdf',
            page: 2,
            display: SEEDED_CONFLICT.memoValue.display,
            context:
              'Comparable Transactions Overview: "...at a cap rate of approximately 6.10%, ' +
              'consistent with prevailing suburban office cap rates at the time the asset was ' +
              'first underwritten."',
          },
        ],
        note: SEEDED_CONFLICT.note,
      },
      {
        id: SEEDED_NOI_CONFLICT.id,
        property: SEEDED_NOI_CONFLICT.property,
        locations: [
          {
            file: 'comps.xlsx',
            sheet: 'Comps',
            cell: 'G7',
            value: SEEDED_NOI_CONFLICT.sheetValue.raw,
            display: SEEDED_NOI_CONFLICT.sheetValue.display,
          },
          {
            file: 'noi-summary.csv',
            sheet: 'CSV',
            cell: 'C7',
            value: SEEDED_NOI_CONFLICT.csvValue.raw,
            display: SEEDED_NOI_CONFLICT.csvValue.display,
          },
        ],
        note: SEEDED_NOI_CONFLICT.note,
      },
    ],
    canaries: [
      {
        id: 'canary-xlsx-001',
        token: CANARY_MARKERS.xlsx.token,
        file: CANARY_MARKERS.xlsx.file,
        location: CANARY_MARKERS.xlsx.location,
        description: CANARY_MARKERS.xlsx.description,
      },
      {
        id: 'canary-pdf-001',
        token: CANARY_MARKERS.pdf.token,
        file: CANARY_MARKERS.pdf.file,
        location: CANARY_MARKERS.pdf.location,
        description: CANARY_MARKERS.pdf.description,
      },
    ],
  };
}
