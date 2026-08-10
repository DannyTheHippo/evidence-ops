import { CANARY_MARKERS, SEEDED_CONFLICT } from './constants';
import { sha256Hex } from './hash';
import type { DocxParagraphManifest } from './build-lease-summary';
import type { SheetManifest } from './build-comps-sheet';

export interface DataRoomManifest {
  generatedAt: string;
  files: {
    'comps.xlsx': { sha256: string; sheets: SheetManifest[] };
    'valuation-memo.pdf': { sha256: string; pageCount: number };
    'market-overview.pdf': { sha256: string; pageCount: number };
    'lease-summary.docx': { sha256: string; paragraphs: DocxParagraphManifest[] };
  };
  conflict: {
    id: string;
    property: string;
    locations: [
      { file: 'comps.xlsx'; sheet: string; cell: string; value: number; display: string },
      { file: 'valuation-memo.pdf'; page: number; display: string; context: string },
    ];
    note: string;
  };
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
    conflict: {
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
