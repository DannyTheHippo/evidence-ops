import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypedConfigService } from '../config/environment/typed-config.service';
import { Approval, ApprovalSchema } from '../database/schemas/workflow/approval/approval.schema';
import { APPROVAL_CHANNEL } from './approval-channel/approval-channel.interface';
import { MongoApprovalChannel } from './approval-channel/mongo-approval.channel';
import { EMBEDDING_PROVIDER } from './embedding/embedding-provider.interface';
import { VoyageEmbeddingProvider } from './embedding/voyage-embedding.provider';
import { AnthropicModelProvider } from './model/anthropic-model.provider';
import {
  CachingModelProvider,
  MODEL_CACHE_OPTIONS,
  type CachingModelProviderOptions,
} from './model/caching-model.provider';
import { MODEL_PROVIDER, type ModelProvider } from './model/model-provider.interface';
import { TracingModelProvider } from './model/tracing-model.provider';
import { MongoHybridRetrievalStore } from './retrieval/mongo-hybrid.store';
import { RETRIEVAL_STORE } from './retrieval/retrieval-store.interface';
import { DOCUMENT_STORE } from './storage/document-store.interface';
import { GridFsDocumentStore } from './storage/gridfs-document.store';
import { LoggerTelemetry } from './telemetry/logger-telemetry';
import { TELEMETRY, type Telemetry } from './telemetry/telemetry.interface';
import { WORKFLOW_ENGINE } from './workflow-engine/workflow-engine.interface';
import { TemporalWorkflowEngine } from './workflow-engine/temporal-workflow.engine';

/**
 * Off by default: turning on record/replay is an eval-harness/script decision made at the
 * call site, not a boot-time one. Wiring it to an env var would be the six-place environment
 * checklist (`contexts/configuration.md`) for a knob nothing reads yet — out of scope here.
 */
const MODEL_CACHE_DEFAULT_OPTIONS: CachingModelProviderOptions = {
  mode: 'off',
  cacheDir: '.cache/model-provider',
};

/**
 * `CachingModelProvider` and `TracingModelProvider` take a `ModelProvider`/`Telemetry`
 * interface positionally rather than an `@Inject()`-tagged constructor param, so Nest's
 * reflection-based `useClass` can't resolve them — they're assembled by hand in this factory
 * instead. `AnthropicModelProvider` has a concrete, decorated constructor, so it stays a normal
 * class provider and is only referenced here via its `inject` token.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: Approval.name, schema: ApprovalSchema }])],
  providers: [
    AnthropicModelProvider,
    { provide: TELEMETRY, useClass: LoggerTelemetry },
    { provide: MODEL_CACHE_OPTIONS, useValue: MODEL_CACHE_DEFAULT_OPTIONS },
    {
      provide: MODEL_PROVIDER,
      inject: [AnthropicModelProvider, MODEL_CACHE_OPTIONS, TELEMETRY, TypedConfigService],
      useFactory: (
        anthropic: AnthropicModelProvider,
        cacheOptions: CachingModelProviderOptions,
        telemetry: Telemetry,
        config: TypedConfigService,
      ): ModelProvider =>
        new TracingModelProvider(
          new CachingModelProvider(anthropic, cacheOptions),
          telemetry,
          config.telemetry.captureModelContent,
        ),
    },
    { provide: EMBEDDING_PROVIDER, useClass: VoyageEmbeddingProvider },

    // RETRIEVAL_STORE, DOCUMENT_STORE, WORKFLOW_ENGINE, and now APPROVAL_CHANNEL bind their real
    // implementations here — their fakes stay in the tree because unit tests still bind them
    // directly, not through this module. WORKFLOW_ENGINE is the one exception that needs an
    // e2e-level override rather than just a unit-level one: TemporalWorkflowEngine only dials a
    // server when start()/status() is actually called, and QaService.startQuestion does call
    // start() on the real answer workflow — so `test/utils/create-test-app.ts` overrides the
    // token back to FakeWorkflowEngine, so no e2e spec accidentally reaches a live Temporal
    // server just by booting AppModule. MongoApprovalChannel dials nothing at construction or at
    // module boot (same as RETRIEVAL_STORE/DOCUMENT_STORE) — no e2e override needed.
    { provide: RETRIEVAL_STORE, useClass: MongoHybridRetrievalStore },
    { provide: DOCUMENT_STORE, useClass: GridFsDocumentStore },
    { provide: WORKFLOW_ENGINE, useClass: TemporalWorkflowEngine },
    { provide: APPROVAL_CHANNEL, useClass: MongoApprovalChannel },
  ],
  exports: [
    MODEL_PROVIDER,
    EMBEDDING_PROVIDER,
    RETRIEVAL_STORE,
    DOCUMENT_STORE,
    WORKFLOW_ENGINE,
    TELEMETRY,
    APPROVAL_CHANNEL,
  ],
})
export class ProvidersModule {}
