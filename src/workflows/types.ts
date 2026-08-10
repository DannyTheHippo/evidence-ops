/**
 * Argument/return contracts for `src/workflows/**`, kept independent of `IngestionResult`
 * (`src/features/evidence/ingestion/ingestion.service.ts`) even though the shape matches —
 * importing from a service file here, even `import type`, would defeat the point of this
 * directory being the one place the determinism fence (`eslint.config.mjs`, ADR-0003) polices.
 */
export interface IngestDocumentVersionInput {
  readonly documentVersionId: string;
}

export interface IngestDocumentVersionResult {
  readonly chunksCreated: number;
  readonly alreadyIngested: boolean;
}
