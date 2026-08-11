import type {
  PdfPageLocator,
  XlsxRegionLocator,
} from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { computeChunkId } from '../../../../src/features/evidence/ingestion/compute-chunk-id';

describe('computeChunkId', () => {
  const sha256 = 'a'.repeat(64);
  const locator: PdfPageLocator = {
    kind: 'pdf-page',
    page: 1,
    extractorVersion: 'pdf-pdfjs-1',
  };

  it('should return the same id for the same sha256, ordinal, and locator', () => {
    const first = computeChunkId({ documentVersionSha256: sha256, ordinal: 0, locator });
    const second = computeChunkId({ documentVersionSha256: sha256, ordinal: 0, locator });

    expect(first).toBe(second);
  });

  // The property that makes eval replay possible (ADR-0007): re-ingesting identical bytes must
  // reproduce identical chunk ids, or the synthesis prompt (and therefore its cache key) differs
  // on every run.
  it('should return the same id regardless of the locator object property insertion order', () => {
    const constructedInOrder: PdfPageLocator = {
      kind: 'pdf-page',
      page: 1,
      extractorVersion: 'pdf-pdfjs-1',
    };
    const constructedOutOfOrder: PdfPageLocator = {
      extractorVersion: 'pdf-pdfjs-1',
      page: 1,
      kind: 'pdf-page',
    };

    const first = computeChunkId({
      documentVersionSha256: sha256,
      ordinal: 3,
      locator: constructedInOrder,
    });
    const second = computeChunkId({
      documentVersionSha256: sha256,
      ordinal: 3,
      locator: constructedOutOfOrder,
    });

    expect(first).toBe(second);
  });

  it('should return a different id for a different ordinal', () => {
    const first = computeChunkId({ documentVersionSha256: sha256, ordinal: 0, locator });
    const second = computeChunkId({ documentVersionSha256: sha256, ordinal: 1, locator });

    expect(first).not.toBe(second);
  });

  it('should return a different id for a different documentVersionSha256', () => {
    const first = computeChunkId({ documentVersionSha256: sha256, ordinal: 0, locator });
    const second = computeChunkId({
      documentVersionSha256: 'b'.repeat(64),
      ordinal: 0,
      locator,
    });

    expect(first).not.toBe(second);
  });

  it('should return a different id for a different locator, holding sha256 and ordinal constant', () => {
    const regionLocator: XlsxRegionLocator = {
      kind: 'xlsx-region',
      sheetName: 'Comps',
      range: 'A1:C10',
      extractorVersion: 'xlsx-1',
    };

    const first = computeChunkId({ documentVersionSha256: sha256, ordinal: 0, locator });
    const second = computeChunkId({
      documentVersionSha256: sha256,
      ordinal: 0,
      locator: regionLocator,
    });

    expect(first).not.toBe(second);
  });

  it('should throw on an empty documentVersionSha256', () => {
    expect(() => computeChunkId({ documentVersionSha256: '', ordinal: 0, locator })).toThrow(
      /non-empty documentVersionSha256/,
    );
  });

  it.each([-1, 1.5])('should throw on a non-integer or negative ordinal (%s)', (ordinal) => {
    expect(() => computeChunkId({ documentVersionSha256: sha256, ordinal, locator })).toThrow(
      /non-negative integer ordinal/,
    );
  });
});
