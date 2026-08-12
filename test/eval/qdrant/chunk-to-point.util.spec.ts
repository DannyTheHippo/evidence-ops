import { Types } from 'mongoose';
import {
  assertUniformEmbeddingLength,
  toPoint,
  type RawEvidenceChunkRow,
} from '../../../eval/qdrant/chunk-to-point.util';
import { chunkIdToPointId } from '../../../eval/qdrant/qdrant-point-id.util';

const CHUNK_ID = 'c'.repeat(64);

function buildRow(overrides: Partial<RawEvidenceChunkRow> = {}): RawEvidenceChunkRow {
  return {
    _id: CHUNK_ID,
    embedding: [0.1, 0.2, 0.3],
    documentVersionId: new Types.ObjectId('507f1f77bcf86cd799439011'),
    text: 'The cap rate is 6.5%.',
    locator: { kind: 'pdf-page', page: 3, extractorVersion: 'pdf-v1' },
    tenantId: 'eval',
    ...overrides,
  };
}

describe('toPoint', () => {
  it('should map a row to a point with the derived point id', () => {
    const row = buildRow();

    const point = toPoint(row);

    expect(point.id).toBe(chunkIdToPointId(CHUNK_ID));
  });

  it('should carry the stored embedding through as the point vector', () => {
    const row = buildRow({ embedding: [1, 2, 3, 4] });

    expect(toPoint(row).vector).toEqual([1, 2, 3, 4]);
  });

  it('should map the payload fields, stringifying documentVersionId like toRetrievalHit does', () => {
    const documentVersionId = new Types.ObjectId('507f191e810c19729de860ea');
    const row = buildRow({ documentVersionId });

    const point = toPoint(row);

    expect(point.payload).toEqual({
      chunkId: CHUNK_ID,
      documentVersionId: documentVersionId.toString(),
      text: row.text,
      locator: row.locator,
      tenantId: row.tenantId,
    });
  });
});

describe('assertUniformEmbeddingLength', () => {
  it('should return the shared dimension when every row matches', () => {
    const rows = [
      buildRow({ _id: 'a'.repeat(64), embedding: [1, 2, 3] }),
      buildRow({ _id: 'b'.repeat(64), embedding: [4, 5, 6] }),
    ];

    expect(assertUniformEmbeddingLength(rows)).toBe(3);
  });

  it('should throw when a row has no embedding', () => {
    const rows = [buildRow({ embedding: [] })];

    expect(() => assertUniformEmbeddingLength(rows)).toThrow();
  });

  it('should throw on a dimension mismatch between rows', () => {
    const rows = [
      buildRow({ _id: 'a'.repeat(64), embedding: [1, 2, 3] }),
      buildRow({ _id: 'b'.repeat(64), embedding: [1, 2] }),
    ];

    expect(() => assertUniformEmbeddingLength(rows)).toThrow();
  });

  it('should throw when given no rows', () => {
    expect(() => assertUniformEmbeddingLength([])).toThrow();
  });
});
