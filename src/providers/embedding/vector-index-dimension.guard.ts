import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { COLLECTION, VECTOR_INDEX } from '../retrieval/retrieval.constant';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding-provider.interface';
import { VectorIndexDimensionMismatchError } from './errors/vector-index-dimension-mismatch.error';

/** `$listSearchIndexes`'s payload shape — the driver's public type only declares `name`; the field
 * this guard needs is nested under `latestDefinition.fields`, verified against a live
 * `mongodb/mongodb-atlas-local` container. */
interface VectorIndexDocument {
  latestDefinition?: {
    fields?: readonly { type?: string; path?: string; numDimensions?: number }[];
  };
}

/**
 * Refuses to finish booting when the live `evidence_chunks_vector` index and the selected
 * `EmbeddingProvider`'s width disagree — a departure from `MongoHybridRetrievalStore`'s lazy
 * first-query probe, deliberate because `IngestionService` writes vectors without ever running
 * that probe: the mismatch must be caught before any embed reaches the index, not on the first
 * query against it.
 *
 * FAILURE DIRECTION is asymmetric by design. CLOSED on a present index reporting another width —
 * throws `VectorIndexDimensionMismatchError` and the process never finishes booting. OPEN on
 * "cannot tell" — the `$listSearchIndexes` command rejected (no `mongot`, e.g. the e2e lane's
 * mongodb-memory-server), or the index not existing yet (before `migrate:up`), or reporting no
 * `embedding` vector field — logs a warning and returns rather than refusing to boot, because both
 * of those states are already refused at first query by `MongoHybridRetrievalStore`, and a fresh
 * database always builds its index from the same `EMBEDDING_DIMENSIONS` this provider reads.
 */
@Injectable()
export class VectorIndexDimensionGuard implements OnApplicationBootstrap {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    let documents: VectorIndexDocument[];
    try {
      documents =
        ((await this.connection.db
          ?.collection(COLLECTION)
          .listSearchIndexes(VECTOR_INDEX)
          .toArray()) as VectorIndexDocument[] | undefined) ?? [];
    } catch (error) {
      Logger.warn(
        `Vector index width not verified: ${error instanceof Error ? error.message : String(error)}`,
        VectorIndexDimensionGuard.name,
      );
      return;
    }

    const document = documents[0];
    if (!document) {
      Logger.warn(
        `Vector index width not verified: '${VECTOR_INDEX}' does not exist yet`,
        VectorIndexDimensionGuard.name,
      );
      return;
    }

    const embeddingField = (document.latestDefinition?.fields ?? []).find(
      (field) => field.type === 'vector' && field.path === 'embedding',
    );
    if (embeddingField?.numDimensions === undefined) {
      Logger.warn(
        `Vector index width not verified: '${VECTOR_INDEX}' has no 'embedding' vector field`,
        VectorIndexDimensionGuard.name,
      );
      return;
    }

    if (embeddingField.numDimensions !== this.embeddingProvider.info.dimensions) {
      throw new VectorIndexDimensionMismatchError(
        embeddingField.numDimensions,
        this.embeddingProvider.info.dimensions,
        this.embeddingProvider.info.provider,
        this.embeddingProvider.info.model,
      );
    }
  }
}
