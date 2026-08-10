import type { INestApplicationContext } from '@nestjs/common';
import { IngestionService } from '../features/evidence/ingestion/ingestion.service';
import type { IngestDocumentVersionResult } from '../workflows/types';

/**
 * Activity function signatures. Workflow code imports this interface `import type` only (see
 * `src/workflows/ingest-document-version.workflow.ts`) so the type-erasure boundary is explicit:
 * a workflow file that switched to a value import of this module would pull `@nestjs/common` and
 * `IngestionService` (and, transitively, mongoose) into the workflow bundle — exactly what the
 * bundler half of the determinism fence exists to reject (ADR-0003).
 */
export interface Activities {
  ingestDocumentVersion(documentVersionId: string): Promise<IngestDocumentVersionResult>;
}

/**
 * Activities are thin closures over services resolved from the worker's own Nest application
 * context (`worker.module.ts`, booted in `main.ts`) — the same DI graph the API process uses, per
 * ADR-0003's "Wiring to NestJS" section. All non-deterministic work (the Mongo reads/writes,
 * parsing, embedding inside `IngestionService.ingestVersion`) lives here, never in workflow code.
 */
export function createActivities(app: INestApplicationContext): Activities {
  const ingestionService = app.get(IngestionService);

  return {
    ingestDocumentVersion: (documentVersionId) => ingestionService.ingestVersion(documentVersionId),
  };
}
