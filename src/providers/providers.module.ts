import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TypedConfigService } from '../config/environment/typed-config.service';
import {
  ModelSpendWindow,
  ModelSpendWindowSchema,
} from '../database/schemas/platform/model-spend-window/model-spend-window.schema';
import { Approval, ApprovalSchema } from '../database/schemas/workflow/approval/approval.schema';
import { AlsContext } from '../shared/types/als-context.type';
import { APPROVAL_CHANNEL } from './approval-channel/approval-channel.interface';
import { MongoApprovalChannel } from './approval-channel/mongo-approval.channel';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from './embedding/embedding-provider.interface';
import { OpenAiCompatibleEmbeddingProvider } from './embedding/openai-compatible-embedding.provider';
import { SpendGuardEmbeddingProvider } from './embedding/spend-guard-embedding.provider';
import { VectorIndexDimensionGuard } from './embedding/vector-index-dimension.guard';
import { VoyageEmbeddingProvider } from './embedding/voyage-embedding.provider';
import { computeVoyageCostUsd } from './embedding/voyage-pricing.table';
import { AnthropicModelProvider } from './model/anthropic-model.provider';
import {
  CachingModelProvider,
  MODEL_CACHE_OPTIONS,
  type CachingModelProviderOptions,
} from './model/caching-model.provider';
import { MetricsModelProvider } from './model/metrics-model.provider';
import { MODEL_PROVIDER, type ModelProvider } from './model/model-provider.interface';
import {
  assertCompatiblePricesConfigured,
  OpenAiCompatibleModelProvider,
} from './model/openai-compatible-model.provider';
import { OpenAiModelProvider } from './model/openai-model.provider';
import { SpendGuardModelProvider } from './model/spend-guard-model.provider';
import { TenantSpendService } from './model/spend/tenant-spend.service';
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
 * `Caching(Metrics(SpendGuard(base)))` chain — SpendGuard sits inside Caching deliberately. A
 * replay-cache hit costs no money, so it must not consume budget: if SpendGuard wrapped Caching,
 * every cached replay would reserve and settle spend that was never actually spent, and the eval
 * harness — which replays hundreds of cached calls — would exhaust a tenant's daily ceiling for
 * free.
 *
 * `Metrics` sits inside `Caching` for the same reason: `CachingModelProvider` returns a cached
 * result without ever calling its inner provider, so a decorator wrapping `Caching` from the
 * outside would observe every replay too. Placed here, `Metrics` only runs on a call that
 * actually reaches `SpendGuard`/`base` — a live call or a record-mode miss — so a cache hit
 * records nothing on the cost histogram. Spend is a separate concern, already secured by the
 * Caching-outside-SpendGuard ordering above: a cache hit never reaches `SpendGuardModelProvider`
 * either way, regardless of where `Metrics` sits.
 *
 * This placement has an accepted cache-observability cost: a record-mode cache write failure, or
 * a non-`ENOENT` cache read failure (`caching-model.provider.ts`'s `readCacheEntry`/
 * `writeCacheEntry`), now propagates with no telemetry, because `Metrics` never sees it. A cache
 * hit also emits no `start`/`success` event, and a cache miss's recorded `durationMs` excludes
 * the cache I/O around it. None of this is reachable through the DI-wired production path —
 * `MODEL_CACHE_DEFAULT_OPTIONS.mode` is `'off'` below, making `Caching` a pass-through — so it
 * only bites the eval harness's record/replay modes, and no error event is added to cover it.
 *
 * `CachingModelProvider`, `MetricsModelProvider`, and `SpendGuardModelProvider` take a
 * `ModelProvider`/`Telemetry` interface positionally rather than an `@Inject()`-tagged
 * constructor param, so Nest's reflection-based `useClass` can't resolve them — they're
 * assembled by hand here instead. `AnthropicModelProvider`, `OpenAiModelProvider` and
 * `OpenAiCompatibleModelProvider` all have concrete, decorated constructors, so they stay normal
 * class providers and are only referenced here via their `inject` tokens.
 *
 * Extracted as a plain, exported function (rather than inlined into the `MODEL_PROVIDER`
 * factory below) so the base selection and the chain order are unit-testable without booting
 * this module's Mongoose-backed DI graph.
 */
export function createModelProvider(
  anthropic: ModelProvider,
  openai: ModelProvider,
  openaiCompatible: ModelProvider,
  spendService: TenantSpendService,
  cacheOptions: CachingModelProviderOptions,
  telemetry: Telemetry,
  config: TypedConfigService,
): ModelProvider {
  if (config.model.provider === 'openai-compatible') {
    assertCompatiblePricesConfigured(config);
  }

  const base =
    config.model.provider === 'openai'
      ? openai
      : config.model.provider === 'openai-compatible'
        ? openaiCompatible
        : anthropic;

  return new CachingModelProvider(
    new MetricsModelProvider(
      new SpendGuardModelProvider(
        base,
        spendService,
        config.spend.dailyLimitUsd,
        config.spend.ingestDailyLimitUsd,
      ),
      telemetry,
    ),
    cacheOptions,
  );
}

/**
 * Wraps the selected base `EmbeddingProvider` (`config.embedding.provider`, independent of
 * `config.model.provider`) in `SpendGuardEmbeddingProvider` — production has no embedding cache to
 * order the guard against (unlike the model chain's `Caching(Metrics(SpendGuard(base)))`); the
 * only `CachingEmbeddingProvider` in the tree is `eval/providers/caching-embedding.provider.ts`,
 * which replaces this token wholesale via `overrideProvider` rather than decorating it, so the
 * eval's free-replay property already holds with no spend guard in that path at all.
 *
 * Reuses `config.spend.dailyLimitUsd`/`config.spend.ingestDailyLimitUsd` and `TenantSpendService`
 * — one combined ledger per tenant across model and embedding spend, not a second one; see
 * `SpendGuardEmbeddingProvider`'s own doc comment for how the ingest sub-ceiling applies within it.
 *
 * `computeVoyageCostUsd` prices the voyage base from its own table; the compatible base has no
 * table entry (its model id is neither vendor's), so its cost is the configured
 * `OPENAI_COMPATIBLE_EMBEDDING_PRICE_USD_PER_MTOK` rate applied to the real `totalTokens` Voyage
 * and the compatible endpoint both report post-call — `environment.config.ts`'s `superRefine`
 * guarantees that price is set whenever `EMBEDDING_PROVIDER=openai-compatible` selects this base,
 * so an undefined value reaching here means that refusal was bypassed rather than a normal runtime
 * state — fails CLOSED at construction rather than pricing every embed at $0.
 *
 * Extracted as a plain, exported function for the same unit-testability reason
 * `createModelProvider` is.
 */
export function createEmbeddingProvider(
  voyage: EmbeddingProvider,
  openaiCompatible: EmbeddingProvider,
  spendService: TenantSpendService,
  als: AsyncLocalStorage<AlsContext>,
  config: TypedConfigService,
): EmbeddingProvider {
  if (config.embedding.provider === 'openai-compatible') {
    const priceUsdPerMtok = config.openaiCompatible.embeddingPriceUsdPerMtok;
    if (priceUsdPerMtok === undefined) {
      throw new Error(
        'OPENAI_COMPATIBLE_EMBEDDING_PRICE_USD_PER_MTOK is required once ' +
          'EMBEDDING_PROVIDER=openai-compatible selects this provider',
      );
    }

    return new SpendGuardEmbeddingProvider(
      openaiCompatible,
      spendService,
      config.spend.dailyLimitUsd,
      als,
      config.spend.ingestDailyLimitUsd,
      (_model, totalTokens) => (totalTokens * priceUsdPerMtok) / 1_000_000,
    );
  }

  return new SpendGuardEmbeddingProvider(
    voyage,
    spendService,
    config.spend.dailyLimitUsd,
    als,
    config.spend.ingestDailyLimitUsd,
    computeVoyageCostUsd,
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
    OpenAiCompatibleModelProvider,
    VoyageEmbeddingProvider,
    OpenAiCompatibleEmbeddingProvider,
    TenantSpendService,
    { provide: TELEMETRY, useClass: LoggerTelemetry },
    { provide: MODEL_CACHE_OPTIONS, useValue: MODEL_CACHE_DEFAULT_OPTIONS },
    {
      provide: MODEL_PROVIDER,
      inject: [
        AnthropicModelProvider,
        OpenAiModelProvider,
        OpenAiCompatibleModelProvider,
        TenantSpendService,
        MODEL_CACHE_OPTIONS,
        TELEMETRY,
        TypedConfigService,
      ],
      useFactory: createModelProvider,
    },
    {
      provide: EMBEDDING_PROVIDER,
      inject: [
        VoyageEmbeddingProvider,
        OpenAiCompatibleEmbeddingProvider,
        TenantSpendService,
        AsyncLocalStorage,
        TypedConfigService,
      ],
      useFactory: createEmbeddingProvider,
    },
    // Runs its `OnApplicationBootstrap` hook once the module graph above is assembled, so
    // `EMBEDDING_PROVIDER` already resolves to whichever base `config.embedding.provider` selected.
    VectorIndexDimensionGuard,
    { provide: SOURCE_CONNECTOR, useClass: LocalFolderSourceConnector },

    // RETRIEVAL_STORE, DOCUMENT_STORE, WORKFLOW_ENGINE, and now APPROVAL_CHANNEL bind their real
    // implementations here — their fakes stay in the tree because unit tests still bind them
    // directly, not through this module. WORKFLOW_ENGINE and RETRIEVAL_STORE are the two exceptions
    // that need an e2e-level override rather than just a unit-level one: TemporalWorkflowEngine
    // only dials a server when start()/status() is actually called, and QaService.startQuestion
    // does call start() on the real answer workflow; MongoHybridRetrievalStore runs
    // $search/$vectorSearch/$rankFusion, which mongodb-memory-server does not support, and
    // RetrievalController is a synchronous, e2e-reachable caller of it. So
    // `test/utils/create-test-app.ts` overrides both tokens back to their fakes, so no e2e spec
    // accidentally reaches a live Temporal server or an unsupported aggregation operator just by
    // booting AppModule. MongoApprovalChannel dials nothing at construction or at module boot (same
    // as DOCUMENT_STORE) — no e2e override needed.
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
