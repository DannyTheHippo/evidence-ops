import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../../../database/schemas/administration/user/user.schema';
import {
  Conflict,
  ConflictSchema,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  DocumentVersion,
  DocumentVersionSchema,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  Document,
  DocumentSchema,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  EvidenceChunk,
  EvidenceChunkSchema,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import {
  ExtractedFact,
  ExtractedFactSchema,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { WorkflowRunsModule } from '../workflow-runs/workflow-runs.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

// `ExtractedFact` and `Conflict` schemas are registered here, not pulled in through
// `ConflictsModule`/`FactsModule`, for the same reason `EvidenceChunk` already is:
// `DocumentsService.remove`'s cascade needs direct model access to delete/update rows
// tenant-scoped and in a specific order, not another service's business logic. `User` is
// registered so `DocumentsService.streamList` can re-read the connecting user's tenant on each
// `reauthTicks$` tick — see `ApiKeysModule`'s identical `User` registration for the same reason.
// `WorkflowRunsModule` is for `WorkflowRunsService` — `DocumentsService.uploadVersion` records a
// run for every version that starts ingestion, mirroring `ConflictsModule`'s identical import.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Document.name, schema: DocumentSchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
      { name: EvidenceChunk.name, schema: EvidenceChunkSchema },
      { name: ExtractedFact.name, schema: ExtractedFactSchema },
      { name: Conflict.name, schema: ConflictSchema },
      { name: User.name, schema: UserSchema },
    ]),
    ProvidersModule,
    WorkflowRunsModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  /** `SourcesModule` injects `DocumentsService` — `SourcesService.runSync` uploads a synced
   * file's bytes through the same content-addressed upload path a manual upload uses. */
  exports: [DocumentsService],
})
export class DocumentsModule {}
