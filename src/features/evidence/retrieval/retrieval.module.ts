import { Module } from '@nestjs/common';
import { QaModule } from '../qa/qa.module';
import { RetrievalController } from './retrieval.controller';
import { RetrievalService } from './retrieval.service';

/**
 * Imports `QaModule` for its exported `EvidenceRetrievalService` rather than reaching into
 * `ProvidersModule`/`RETRIEVAL_STORE` directly — the `DocumentVersion` model registration and
 * `RETRIEVAL_STORE` binding `EvidenceRetrievalService` needs already live behind that module's DI
 * graph, and duplicating them here would construct a second, separately-wired instance.
 */
@Module({
  imports: [QaModule],
  controllers: [RetrievalController],
  providers: [RetrievalService],
})
export class RetrievalModule {}
