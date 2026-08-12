import type { Types } from 'mongoose';
import type { EvidenceLocator } from '../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { chunkIdToPointId } from './qdrant-point-id.util';

/**
 * Shape of one raw `evidence_chunks` row as read for the Qdrant benchmark — deliberately narrow
 * to the fields `toPoint` actually consumes, mirroring `MongoHybridRetrievalStore`'s own
 * `RawEvidenceChunkDoc` rather than importing the full Mongoose-hydrated document type.
 */
export interface RawEvidenceChunkRow {
  readonly _id: string;
  readonly embedding: readonly number[];
  readonly documentVersionId: Types.ObjectId;
  readonly text: string;
  readonly locator: EvidenceLocator;
  readonly tenantId: string;
}

export interface QdrantPointPayload {
  readonly chunkId: string;
  readonly documentVersionId: string;
  readonly text: string;
  readonly locator: EvidenceLocator;
  readonly tenantId: string;
}

export interface QdrantPoint {
  readonly id: string;
  readonly vector: readonly number[];
  readonly payload: QdrantPointPayload;
}

/**
 * Maps one `evidence_chunks` row to a Qdrant point. `documentVersionId` is stringified the same
 * way `MongoHybridRetrievalStore.toRetrievalHit` does (`doc.documentVersionId.toString()`) so a
 * benchmark comparing the two stores' hits sees the identical field shape on both sides. The real
 * `chunkId` rides in the payload rather than only in the point id because `chunkIdToPointId`'s
 * mapping is one-way (see that function's doc comment) — this is the only place a hit can be
 * traced back to the chunk it came from.
 */
export function toPoint(row: RawEvidenceChunkRow): QdrantPoint {
  return {
    id: chunkIdToPointId(row._id),
    vector: row.embedding,
    payload: {
      chunkId: row._id,
      documentVersionId: row.documentVersionId.toString(),
      text: row.text,
      locator: row.locator,
      tenantId: row.tenantId,
    },
  };
}

/**
 * Returns the shared embedding dimension across `rows`, throwing rather than skipping on a
 * missing embedding or a length mismatch — silently dropping a chunk here would bias recall
 * downward and make the benchmark lie in the challenger's favour by discarding exactly the rows
 * that would have counted against it. The dimension is derived from the stored data rather than
 * read from `VOYAGE_DIMENSIONS` both because `process.env` is confined to one config file in this
 * project (`environment.config.ts`) and because deriving it self-verifies against what was
 * actually indexed, instead of trusting a config value that could drift from the real data.
 */
export function assertUniformEmbeddingLength(rows: readonly RawEvidenceChunkRow[]): number {
  if (rows.length === 0) {
    throw new Error('assertUniformEmbeddingLength requires at least one row');
  }
  const [first, ...rest] = rows;
  if (first.embedding.length === 0) {
    throw new Error(`evidence chunk ${first._id} has no embedding`);
  }
  const dimension = first.embedding.length;
  for (const row of rest) {
    if (row.embedding.length === 0) {
      throw new Error(`evidence chunk ${row._id} has no embedding`);
    }
    if (row.embedding.length !== dimension) {
      throw new Error(
        `evidence chunk ${row._id} has embedding length ${row.embedding.length}, expected ${dimension}`,
      );
    }
  }
  return dimension;
}
