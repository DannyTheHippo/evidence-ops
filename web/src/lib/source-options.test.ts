import { describe, expect, it } from 'vitest';
import type { DocumentSourceClass, SourceKind } from '../api/client';
import { CLASS_OPTIONS, SOURCE_KIND_LABELS, sourceClassLabel } from './source-options';

// Every `DocumentSourceClass`/`SourceKind` the server can send — kept in sync with the schema by
// the two `Record<…, string>` label maps (`CLASS_OPTIONS` derives from one), which fail to
// compile the moment a member is dropped or added there.
const ALL_CLASSES: DocumentSourceClass[] = CLASS_OPTIONS.map((option) => option.value);
const ALL_KINDS: SourceKind[] = Object.keys(SOURCE_KIND_LABELS) as SourceKind[];

describe('sourceClassLabel', () => {
  it.each(ALL_CLASSES)('resolves %s to a non-raw label', (value) => {
    expect(sourceClassLabel(value)).not.toBe(value);
  });
});

describe('SOURCE_KIND_LABELS', () => {
  it.each(ALL_KINDS)('resolves %s to a non-raw label', (kind) => {
    expect(SOURCE_KIND_LABELS[kind]).not.toBe(kind);
  });
});
