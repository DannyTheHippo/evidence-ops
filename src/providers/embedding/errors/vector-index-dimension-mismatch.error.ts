/**
 * Not a `BaseException`/`HttpException` — thrown from `VectorIndexDimensionGuard`'s
 * `OnApplicationBootstrap` hook, outside any request or Temporal activity scope.
 *
 * Thrown when the live `evidence_chunks_vector` index's `numDimensions` disagrees with the
 * selected `EmbeddingProvider`'s `info.dimensions`. Fails CLOSED: every vector this deployment
 * would write is the wrong width for the index already built, so the process must not finish
 * booting and start accepting ingest or query traffic against it.
 */
export class VectorIndexDimensionMismatchError extends Error {
  constructor(
    public readonly indexDimensions: number,
    public readonly providerDimensions: number,
    public readonly provider: string,
    public readonly model: string,
  ) {
    super(
      `Vector index width (${indexDimensions}) does not match embedding provider ` +
        `'${provider}'/'${model}' (${providerDimensions}). Rebuild the index with a matching ` +
        `EMBEDDING_DIMENSIONS via 'npm run migrate:down && npm run migrate:up', or correct the ` +
        'embedding provider configuration.',
    );
    this.name = 'VectorIndexDimensionMismatchError';
  }
}
