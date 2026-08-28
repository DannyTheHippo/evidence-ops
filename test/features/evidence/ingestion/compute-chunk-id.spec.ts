import type {
  PdfPageLocator,
  XlsxRegionLocator,
} from '../../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { computeChunkId } from '../../../../src/features/evidence/ingestion/compute-chunk-id';

/**
 * The chunker stands in for its own version constant so the rotation property can be asserted as a
 * property — a different chunker derives a different id — rather than pinned to whatever string the
 * constant currently holds. A getter, not a value: `computeChunkId` reads the binding when it runs,
 * which is after this module has initialized. Every test starts from the real constant, so the
 * digest pin below still pins what the running chunker actually produces.
 */
let mockChunkerVersion: string;
jest.mock('../../../../src/features/evidence/ingestion/chunker', () => ({
  get CHUNKER_VERSION(): string {
    return mockChunkerVersion;
  },
}));

const { CHUNKER_VERSION } = jest.requireActual<
  typeof import('../../../../src/features/evidence/ingestion/chunker')
>('../../../../src/features/evidence/ingestion/chunker');

describe('computeChunkId', () => {
  beforeEach(() => {
    mockChunkerVersion = CHUNKER_VERSION;
  });

  const tenantId = 'default';
  const sha256 = 'a'.repeat(64);
  const locator: PdfPageLocator = {
    kind: 'pdf-page',
    page: 1,
    extractorVersion: 'pdf-pdfjs-1',
  };

  // Golden-value pin over the whole set of hash inputs: an id is what an already-stored citation
  // resolves through, so nothing may reach this digest without the change being deliberate. A
  // rotated digest here is a claim that every stored chunk id changes meaning, which is exactly the
  // decision that should not be made silently — either the fixed inputs above no longer produce
  // this digest, or an input was added or removed.
  it('should return the exact same digest for a fixed input (id stability pin)', () => {
    const id = computeChunkId({ tenantId, documentVersionSha256: sha256, ordinal: 0, locator });

    expect(id).toBe('26b46937fb97e56103b9a18bb79da6ca6668bb2dab5924e2e58a1c38a07c4876');
  });

  // The rotation property, asserted over the chunker version rather than the parser's: the chunker
  // decides a chunk's text and boundaries and contributes no coordinate to the locator, so without
  // this an id survives a chunker change and names text that chunker never emitted.
  it('should return a different id for a different chunker version, holding every other input constant', () => {
    const first = computeChunkId({ tenantId, documentVersionSha256: sha256, ordinal: 0, locator });
    mockChunkerVersion = `${CHUNKER_VERSION}-successor`;
    const second = computeChunkId({ tenantId, documentVersionSha256: sha256, ordinal: 0, locator });

    expect(first).not.toBe(second);
  });

  it('should return the same id for the same tenantId, sha256, ordinal, and locator', () => {
    const first = computeChunkId({ tenantId, documentVersionSha256: sha256, ordinal: 0, locator });
    const second = computeChunkId({ tenantId, documentVersionSha256: sha256, ordinal: 0, locator });

    expect(first).toBe(second);
  });

  // The regression that matters: byte-identical content ingested under two different tenants must
  // never derive the same `_id` — an unscoped id lets one tenant's ingest collide with (or worse,
  // dedupe into) another tenant's row at the storage layer.
  it('should return a different id for a different tenantId, holding sha256, ordinal, and locator constant', () => {
    const first = computeChunkId({ tenantId, documentVersionSha256: sha256, ordinal: 0, locator });
    const second = computeChunkId({
      tenantId: 'eval',
      documentVersionSha256: sha256,
      ordinal: 0,
      locator,
    });

    expect(first).not.toBe(second);
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
      tenantId,
      documentVersionSha256: sha256,
      ordinal: 3,
      locator: constructedInOrder,
    });
    const second = computeChunkId({
      tenantId,
      documentVersionSha256: sha256,
      ordinal: 3,
      locator: constructedOutOfOrder,
    });

    expect(first).toBe(second);
  });

  it('should return a different id for a different ordinal', () => {
    const first = computeChunkId({ tenantId, documentVersionSha256: sha256, ordinal: 0, locator });
    const second = computeChunkId({ tenantId, documentVersionSha256: sha256, ordinal: 1, locator });

    expect(first).not.toBe(second);
  });

  it('should return a different id for a different documentVersionSha256', () => {
    const first = computeChunkId({ tenantId, documentVersionSha256: sha256, ordinal: 0, locator });
    const second = computeChunkId({
      tenantId,
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

    const first = computeChunkId({ tenantId, documentVersionSha256: sha256, ordinal: 0, locator });
    const second = computeChunkId({
      tenantId,
      documentVersionSha256: sha256,
      ordinal: 0,
      locator: regionLocator,
    });

    expect(first).not.toBe(second);
  });

  it('should throw on an empty tenantId', () => {
    expect(() =>
      computeChunkId({ tenantId: '', documentVersionSha256: sha256, ordinal: 0, locator }),
    ).toThrow(/non-empty tenantId/);
  });

  it('should throw on an empty documentVersionSha256', () => {
    expect(() =>
      computeChunkId({ tenantId, documentVersionSha256: '', ordinal: 0, locator }),
    ).toThrow(/non-empty documentVersionSha256/);
  });

  it.each([-1, 1.5])('should throw on a non-integer or negative ordinal (%s)', (ordinal) => {
    expect(() =>
      computeChunkId({ tenantId, documentVersionSha256: sha256, ordinal, locator }),
    ).toThrow(/non-negative integer ordinal/);
  });
});
