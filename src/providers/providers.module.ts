import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypedConfigService } from '../config/environment/typed-config.service';
import {
  ModelSpendWindow,
  ModelSpendWindowSchema,
} from '../database/schemas/platform/model-spend-window/model-spend-window.schema';
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
import { OpenAiModelProvider } from './model/openai-model.provider';
import { SpendGuardModelProvider } from './model/spend-guard-model.provider';
import { TenantSpendService } from './model/spend/tenant-spend.service';
import { TracingModelProvider } from './model/tracing-model.provider';
import { MongoHybridRetrievalStore } from './retrieval/mongo-hybrid.store';
import { RETRIEVAL_STORE } from './retrieval/retrieval-store.interface';
import { LocalFolderSourceConnector } from './source-connector/local-folder-source.connector';
import { SOURCE_CONNECTOR } from './source-connector/source-connector.interface';
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
 * Selects the base `ModelProvider` by `config.model.provider` and wraps it in the standing
 * `Tracing(Caching(SpendGuard(base)))` chain — SpendGuard sits inside Caching deliberately. A
 * replay-cache hit costs no money, so it must not consume budget: if SpendGuard wrapped Caching,
 * every cached replay would reserve and settle spend that was never actually spent, and the eval
 * harness — which replays hundreds of cached calls — would exhaust a tenant's daily ceiling for
 * free.
 *
 * `CachingModelProvider`, `SpendGuardModelProvider`, and `TracingModelProvider` take a
 * `ModelProvider`/`Telemetry` interface positionally rather than an `@Inject()`-tagged
 * constructor param, so Nest's reflection-based `useClass` can't resolve them — they're
 * assembled by hand here instead. `AnthropicModelProvider` and `OpenAiModelProvider` both have
 * concrete, decorated constructors, so they stay normal class providers and are only referenced
 * here via their `inject` tokens.
 *
 * Extracted as a plain, exported function (rather than inlined into the `MODEL_PROVIDER`
 * factory below) so the base selection and the chain order are unit-testable without booting
 * this module's Mongoose-backed DI graph.
 */
export function createModelProvider(
  anthropic: ModelProvider,
  openai: ModelProvider,
  spendService: TenantSpendService,
  cacheOptions: CachingModelProviderOptions,
  telemetry: Telemetry,
  config: TypedConfigService,
): ModelProvider {
  const base = config.model.provider === 'openai' ? openai : anthropic;

  return new TracingModelProvider(
    new CachingModelProvider(
      new SpendGuardModelProvider(base, spendService, config.spend.dailyLimitUsd),
      cacheOptions,
    ),
    telemetry,
    config.telemetry.captureModelContent,
  );
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Approval.name, schema: ApprovalSchema },
      { name: ModelSpendWindow.name, schema: ModelSpendWindowSchema },
    ]),
  ],
  providers: [
    AnthropicModelProvider,
    OpenAiModelProvider,
    TenantSpendService,
    { provide: TELEMETRY, useClass: LoggerTelemetry },
    { provide: MODEL_CACHE_OPTIONS, useValue: MODEL_CACHE_DEFAULT_OPTIONS },
    {
      provide: MODEL_PROVIDER,
      inject: [
        AnthropicModelProvider,
        OpenAiModelProvider,
        TenantSpendService,
        MODEL_CACHE_OPTIONS,
        TELEMETRY,
        TypedConfigService,
      ],
      useFactory: createModelProvider,
    },
    { provide: EMBEDDING_PROVIDER, useClass: VoyageEmbeddingProvider },
    { provide: SOURCE_CONNECTOR, useClass: LocalFolderSourceConnector },

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
    SOURCE_CONNECTOR,
    RETRIEVAL_STORE,
    DOCUMENT_STORE,
    WORKFLOW_ENGINE,
    TELEMETRY,
    APPROVAL_CHANNEL,
  ],
})
export class ProvidersModule {}
