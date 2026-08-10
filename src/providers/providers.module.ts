import { Module } from '@nestjs/common';
import { APPROVAL_CHANNEL } from './approval-channel/approval-channel.interface';
import { FakeApprovalChannel } from './approval-channel/fake-approval.channel';
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
  providers: [
    AnthropicModelProvider,
    { provide: TELEMETRY, useClass: LoggerTelemetry },
    { provide: MODEL_CACHE_OPTIONS, useValue: MODEL_CACHE_DEFAULT_OPTIONS },
    {
      provide: MODEL_PROVIDER,
      inject: [AnthropicModelProvider, MODEL_CACHE_OPTIONS, TELEMETRY],
      useFactory: (
        anthropic: AnthropicModelProvider,
        cacheOptions: CachingModelProviderOptions,
        telemetry: Telemetry,
      ): ModelProvider =>
        new TracingModelProvider(new CachingModelProvider(anthropic, cacheOptions), telemetry),
    },
    { provide: EMBEDDING_PROVIDER, useClass: VoyageEmbeddingProvider },

    // Placeholder binding: only a fake exists (see the interface file in the same directory for
    // why). A later milestone swaps it in for a real channel without touching any consumer of
    // the token.
    { provide: APPROVAL_CHANNEL, useClass: FakeApprovalChannel },

    // RETRIEVAL_STORE, DOCUMENT_STORE, and now WORKFLOW_ENGINE bind their real implementations
    // here — their fakes stay in the tree because unit tests still bind them directly, not
    // through this module. WORKFLOW_ENGINE is the one exception that needs an e2e-level override
    // rather than just a unit-level one: TemporalWorkflowEngine only dials a server when
    // start()/status() is actually called (nothing does yet — the real answer workflow is wired
    // in a later step), but `test/utils/create-test-app.ts` still overrides the token back to
    // FakeWorkflowEngine defensively, so no future e2e spec can accidentally reach a live
    // Temporal server just by booting AppModule.
    { provide: RETRIEVAL_STORE, useClass: MongoHybridRetrievalStore },
    { provide: DOCUMENT_STORE, useClass: GridFsDocumentStore },
    { provide: WORKFLOW_ENGINE, useClass: TemporalWorkflowEngine },
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
