import { z } from 'zod';
import { ANTHROPIC_PRICING } from '../../providers/model/anthropic-pricing.table';

/** Coerce common truthy/falsey env strings to a boolean. */
const zBool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
    );

const zNum = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

/** Numeric var restricted to a fixed set of legal values (e.g. Matryoshka embedding dims). */
const zNumEnum = <T extends number>(def: T, allowed: readonly T[]) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(
      z
        .number()
        .finite()
        .refine((n): n is T => allowed.includes(n as T), {
          message: `Must be one of: ${allowed.join(', ')}`,
        }),
    );

/**
 * An unset var and a var set to `""` mean the same thing — "not configured". `.env` files
 * routinely carry blank placeholders (`JWT_SECRET=""`), and a bare `.optional()` lets that
 * blank through, where `??` cannot fall back on it and it reaches the consumer as an empty
 * secret. Normalising here keeps both the prod-required check and the dev fallback honest.
 */
const zOptionalString = () =>
  z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : undefined));

/** Same blank-vs-unset normalisation as `zOptionalString`, for a numeric var with no safe
 * default of its own — "not configured" must stay distinguishable from any real value. */
const zNumOptional = () =>
  z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? Number(v.trim()) : undefined))
    .pipe(z.number().finite().optional());

// Exported so callers outside this module (the login cookie's `Secure`/`__Host-` decision) share
// the one predicate that also gates the MONGO_DB_URI/JWT_SECRET requirement below — a fourth
// prod-like environment added only here must not silently ship an insecure cookie elsewhere.
export const isProdLike = (nodeEnv: string): boolean => ['production', 'staging'].includes(nodeEnv);

// Mirrors `mongo-hybrid.store.ts`'s `PIPELINE_NAMES`/`PIPELINE_WEIGHTS`/`RRF_K`, copied rather
// than imported because that module depends on `TypedConfigService`, which depends on this
// module's own types — importing it here would be circular. `$rankFusion` scores a hit as
// `sum(weight * (1 / (RRF_K + rank)))` across the `search` and `vector` input pipelines, each
// weighted 1. The best any single hit can do is rank 1 in both pipelines at once, so the true
// scale ceiling — not 1, despite the field reading like a 0-1 similarity score — is
// `PIPELINE_COUNT * MAX_PIPELINE_WEIGHT / (RRF_K + 1)`. `test/config/environment.config.spec.ts`
// pins these to the store's real values, so the two can't drift apart silently. Exported for that
// test to import; not otherwise part of this module's public surface.
export const RETRIEVAL_RRF_K = 60;
export const RETRIEVAL_PIPELINE_COUNT = 2;
export const RETRIEVAL_MAX_PIPELINE_WEIGHT = 1;
const RETRIEVAL_SCORE_CEILING =
  (RETRIEVAL_PIPELINE_COUNT * RETRIEVAL_MAX_PIPELINE_WEIGHT) / (RETRIEVAL_RRF_K + 1);

/**
 * Raw-env schema. Validates `process.env` and projects it into namespaced,
 * strongly-typed config objects consumed via `configService.get('<namespace>')`.
 * A parse failure aborts boot with a precise message (fail loud, fail early).
 */
export const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production', 'staging', 'local'])
      .default('development'),
    PORT: zNum(3000),
    // Nest's `LogLevel` union has no `info` member; it is accepted here as an alias for `log`
    // because it is the value this project's operators already know from `docker-compose.yml`.
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'log', 'info', 'debug', 'verbose'])
      .default('info'),
    URL: z.string().default('http://localhost:3000'),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    // Express `trust proxy` hop count. Zero by default: `req.ip` is always the direct socket peer
    // and every `X-Forwarded-For` header is ignored, so a deployment that forgets to set this never
    // silently inherits a reverse proxy it does not have. Set to the exact number of proxies in
    // front of this process — a value too high lets a caller past the real edge spoof `req.ip` via
    // `X-Forwarded-For`, which is what every IP-keyed throttle bucket and login/registration's IP
    // fallback rely on.
    TRUST_PROXY_HOPS: zNum(0),

    MONGO_DB_URI: zOptionalString(),
    MONGO_MEMORY_SERVER: zBool(false),

    JWT_SECRET: zOptionalString(),
    JWT_EXPIRES_IN: z.string().default('7d'),

    // Bounds `POST /auth/login` and `POST /auth/register` (`CredentialThrottleGuard`), each of
    // which runs a bcrypt at cost 12 on the main thread. Far tighter than THROTTLE_LIMIT below,
    // and over a much longer window: the general limit is sized for a human clicking around a UI,
    // whereas these two routes have no legitimate high-frequency use and are the only ones whose
    // cost per unauthenticated request is measured in hundreds of milliseconds of CPU.
    //
    // AUTH_CREDENTIAL_EMAIL_LIMIT bounds a `(email, address)` pair, not an email: it caps how much
    // of one address's allowance can go at a single account, so a source pool's reach against one
    // account grows only with the pool. Bounding the email alone would let any caller spend an
    // account's allowance and lock its owner out, since the bucket is spent before authentication.
    AUTH_CREDENTIAL_WINDOW_MS: zNum(900_000),
    AUTH_CREDENTIAL_IP_LIMIT: zNum(10),
    AUTH_CREDENTIAL_EMAIL_LIMIT: zNum(5),

    THROTTLE_TTL_MS: zNum(60000),
    THROTTLE_LIMIT: zNum(100),

    // 'anthropic' | 'openai' selects which base ModelProvider providers.module.ts wires behind
    // the standing Caching(SpendGuard(base)) chain.
    MODEL_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),

    ANTHROPIC_API_KEY: zOptionalString(),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
    ANTHROPIC_TIMEOUT_MS: zNum(60_000),
    // Per-taskClass routing override for `fact_extraction` only — `claim_verification` and
    // `qa_answer` stay pinned to ANTHROPIC_MODEL. Unset (the default) routes every task class to
    // ANTHROPIC_MODEL, same as before this variable existed.
    ANTHROPIC_MODEL_FACT_EXTRACTION: zOptionalString(),

    // Deliberately optional, no default: self-hosted OpenAI-compatible endpoints (vLLM, Ollama)
    // accept no auth, so a missing key must not throw at construction.
    OPENAI_API_KEY: zOptionalString(),
    // Must name a model priced in `openai-pricing.table.ts`; an unpriced default would throw
    // `UnknownModelPricingError` on the first call, since cost is asserted before every request.
    OPENAI_MODEL: z.string().default('gpt-5'),
    // Overriding this is what makes Azure OpenAI, vLLM, or Ollama reachable.
    OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
    OPENAI_TIMEOUT_MS: zNum(60_000),

    VOYAGE_API_KEY: zOptionalString(),
    VOYAGE_MODEL: z.string().default('voyage-4'),
    VOYAGE_DIMENSIONS: zNumEnum(1024, [256, 512, 1024, 2048] as const),
    // Free-tier default (3 RPM, 5 retries, 5min wait budget) — the account this ships against has
    // no payment method on file and is throttled to those limits; see voyage-embedding.provider.ts.
    VOYAGE_REQUESTS_PER_MINUTE: zNum(3),
    // Paced independently of VOYAGE_REQUESTS_PER_MINUTE (ingest's `document` inputType) so a
    // backfill's own pacer can never delay a `query` embed behind it — see
    // `voyage-embedding.provider.ts`'s `pace`.
    VOYAGE_QUERY_REQUESTS_PER_MINUTE: zNum(3),
    VOYAGE_MAX_RETRIES: zNum(5),
    VOYAGE_MAX_RETRY_WAIT_MS: zNum(300_000),
    VOYAGE_REQUEST_TIMEOUT_MS: zNum(30_000),

    TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    TEMPORAL_TASK_QUEUE: z.string().default('evidence-ops'),

    RETRIEVAL_FUSION: z.enum(['server', 'app']).default('server'),
    RETRIEVAL_LIMIT: zNum(12),
    // Minimum fused RRF score a hit must clear to reach synthesis; `EvidenceRetrievalService`
    // drops anything below it before a chunk is ever built. The fused score sits on the RRF
    // scale bounded by `RETRIEVAL_SCORE_CEILING` above (~0.0328 today), not a 0-1 similarity
    // scale — a value above that ceiling rejects every hit this store can ever return, so it is
    // refused here rather than left to silently abstain on every question. Every hit a
    // `RetrievalStore` returns carries a strictly positive fused score (an RRF contribution of
    // `1 / (60 + rank)` from at least one pipeline), so the default of 0 clears every hit and
    // changes nothing.
    RETRIEVAL_SCORE_FLOOR: zNum(0).pipe(
      z.number().max(RETRIEVAL_SCORE_CEILING, {
        message:
          `Must not exceed ${RETRIEVAL_SCORE_CEILING} — the maximum fused RRF score the ` +
          `retrieval store's pipelines can produce (${RETRIEVAL_PIPELINE_COUNT} pipelines × ` +
          `weight ${RETRIEVAL_MAX_PIPELINE_WEIGHT} / (RRF_K=${RETRIEVAL_RRF_K} + best rank 1)). ` +
          'The fused score is not a 0-1 similarity; a higher value rejects every hit and ' +
          'silently abstains on every question with no error at query time.',
      }),
    ),

    EXTRACTION_CHUNK_CONCURRENCY: zNum(2),
    // Whether an alias read out of a document's own parenthetical definitions starts resolving as
    // soon as it is harvested. Off by default: an applied alias changes which facts share a
    // conflict group across every document already ingested, so the harvester records proposals
    // with their citations and changes no resolution until an operator turns this on deliberately.
    EXTRACTION_ALIAS_HARVEST_AUTO_APPLY: zBool(false),
    // Off means an unmatched numeric spreadsheet column mints nothing during extraction; on
    // means it proposes a measure held for admin confirmation instead of being dropped.
    EXTRACTION_HEADER_PROPOSALS: zBool(false),

    // Gates a lowering-only contradiction check on both verification paths. Off means no
    // contradiction-check model call is ever made and every verdict this codebase already
    // computed passes through unchanged.
    VERIFY_CONTRADICTION_CHECK: zBool(false),

    /** Per-tenant aggregate daily ceiling on model spend, in USD. A value `<= 0` disables the ceiling entirely. */
    MODEL_SPEND_DAILY_LIMIT_USD: zNum(50),
    // Sub-ceiling reserved against the same aggregate ledger for ingest calls (`fact_extraction`,
    // embedding `document` inputType) only — interactive calls (`qa_answer`,
    // `claim_verification`, embedding `query` inputType) keep reserving against the full
    // MODEL_SPEND_DAILY_LIMIT_USD, so a backfill can never exhaust the headroom Q&A depends on.
    // Unset (the default) leaves ingest reserving against the full ceiling too, same as before
    // this variable existed.
    MODEL_SPEND_DAILY_LIMIT_INGEST_USD: zNumOptional(),

    // Set per-process by each start script ('evidence-ops-api' / 'evidence-ops-worker' /
    // 'evidence-ops-mcp'), never read directly from `process.env` outside this file — see
    // `instrumentation.ts`'s use of `telemetry.serviceName` to pick a process's metrics port.
    OTEL_SERVICE_NAME: zOptionalString(),
    // Prometheus's own registered default (9464) — see
    // https://github.com/prometheus/prometheus/wiki/Default-port-allocations. The worker process
    // offsets this by one rather than needing an env var of its own to keep in sync.
    METRICS_PORT: zNum(9464),

    SOURCES_INBOX_DIR: z.string().default('./inbox'),
    SOURCE_SYNC_INTERVAL_MS: zNum(300_000),

    // 3002: distinct from the API's 3000 (host-mapped 3001, docker-compose.yml) and every other
    // port already in use in this stack (mongo host-mapped 27018, temporal UI 8233, web 8090) —
    // the MCP process is a third HTTP-listening process alongside the API.
    MCP_PORT: zNum(3002),
    MCP_RATE_LIMIT_PER_MINUTE: zNum(60),
    // Applied in `src/mcp/main.ts` before `authenticate`, keyed on the caller's IP — distinct from
    // MCP_RATE_LIMIT_PER_MINUTE above, which runs after authentication and is keyed on the
    // verified actor. Tighter than the post-auth limit because an unverified caller costs a Mongo
    // lookup per attempt and writes no audit row on rejection.
    MCP_PRE_AUTH_IP_RATE_LIMIT_WINDOW_MS: zNum(60_000),
    MCP_PRE_AUTH_IP_RATE_LIMIT_MAX_REQUESTS: zNum(20),

    // Bounds concurrent SSE streams so one tenant or user cannot exhaust the server's
    // open-connection budget, and bounds how long any single stream may stay open regardless.
    SSE_MAX_CONNECTIONS_PER_TENANT: zNum(100),
    SSE_MAX_CONNECTIONS_PER_USER: zNum(10),
    SSE_MAX_STREAM_LIFETIME_MS: zNum(1_800_000),

    /** Default lifetime of a newly minted API key when no explicit expiry is requested. */
    API_KEY_DEFAULT_TTL_DAYS: zNum(90),
  })
  .superRefine((e, ctx) => {
    if (isProdLike(e.NODE_ENV)) {
      if (!e.MONGO_DB_URI) {
        ctx.addIssue({
          code: 'custom',
          path: ['MONGO_DB_URI'],
          message: 'Required when NODE_ENV is production or staging',
        });
      }

      if (!e.JWT_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['JWT_SECRET'],
          message: 'Required when NODE_ENV is production or staging',
        });
      }
    }

    if (e.MODEL_SPEND_DAILY_LIMIT_INGEST_USD !== undefined) {
      if (e.MODEL_SPEND_DAILY_LIMIT_USD <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['MODEL_SPEND_DAILY_LIMIT_INGEST_USD'],
          message:
            'Must not be set while MODEL_SPEND_DAILY_LIMIT_USD disables the ceiling (<= 0) — ' +
            'a sub-limit under a disabled ceiling would silently have no effect.',
        });
      } else if (e.MODEL_SPEND_DAILY_LIMIT_INGEST_USD > e.MODEL_SPEND_DAILY_LIMIT_USD) {
        ctx.addIssue({
          code: 'custom',
          path: ['MODEL_SPEND_DAILY_LIMIT_INGEST_USD'],
          message: `Must not exceed MODEL_SPEND_DAILY_LIMIT_USD (${e.MODEL_SPEND_DAILY_LIMIT_USD})`,
        });
      }
    }

    if (
      e.ANTHROPIC_MODEL_FACT_EXTRACTION !== undefined &&
      !(e.ANTHROPIC_MODEL_FACT_EXTRACTION in ANTHROPIC_PRICING)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_MODEL_FACT_EXTRACTION'],
        message: `Must be a model priced in anthropic-pricing.table.ts (one of: ${Object.keys(ANTHROPIC_PRICING).join(', ')})`,
      });
    }
  })
  .transform((e) => {
    // Falls back to dev-only defaults below prod-like; superRefine already guarantees
    // both are present once NODE_ENV is production/staging. Blanks became `undefined`
    // upstream (zOptionalString), so `??` is sufficient here.
    const mongoUri =
      e.MONGO_DB_URI ?? 'mongodb://localhost:27018/evidence-ops?directConnection=true';
    const jwtSecret = e.JWT_SECRET ?? 'dev-only-insecure-jwt-secret';

    return {
      app: {
        env: e.NODE_ENV,
        port: e.PORT,
        logLevel: e.LOG_LEVEL,
        url: e.URL,
        trustProxyHops: e.TRUST_PROXY_HOPS,
      },
      cors: {
        origin: e.CORS_ORIGIN,
      },
      mongo: {
        uri: mongoUri,
        memoryServer: e.MONGO_MEMORY_SERVER,
      },
      auth: {
        jwtSecret,
        jwtExpiresIn: e.JWT_EXPIRES_IN,
        credentialWindowMs: e.AUTH_CREDENTIAL_WINDOW_MS,
        credentialIpLimit: e.AUTH_CREDENTIAL_IP_LIMIT,
        credentialEmailLimit: e.AUTH_CREDENTIAL_EMAIL_LIMIT,
      },
      throttle: {
        ttlMs: e.THROTTLE_TTL_MS,
        limit: e.THROTTLE_LIMIT,
      },
      model: {
        provider: e.MODEL_PROVIDER,
      },
      anthropic: {
        apiKey: e.ANTHROPIC_API_KEY,
        model: e.ANTHROPIC_MODEL,
        timeoutMs: e.ANTHROPIC_TIMEOUT_MS,
        factExtractionModel: e.ANTHROPIC_MODEL_FACT_EXTRACTION,
      },
      openai: {
        apiKey: e.OPENAI_API_KEY,
        model: e.OPENAI_MODEL,
        baseUrl: e.OPENAI_BASE_URL,
        timeoutMs: e.OPENAI_TIMEOUT_MS,
      },
      voyage: {
        apiKey: e.VOYAGE_API_KEY,
        model: e.VOYAGE_MODEL,
        dimensions: e.VOYAGE_DIMENSIONS,
        requestsPerMinute: e.VOYAGE_REQUESTS_PER_MINUTE,
        queryRequestsPerMinute: e.VOYAGE_QUERY_REQUESTS_PER_MINUTE,
        maxRetries: e.VOYAGE_MAX_RETRIES,
        maxRetryWaitMs: e.VOYAGE_MAX_RETRY_WAIT_MS,
        requestTimeoutMs: e.VOYAGE_REQUEST_TIMEOUT_MS,
      },
      temporal: {
        address: e.TEMPORAL_ADDRESS,
        namespace: e.TEMPORAL_NAMESPACE,
        taskQueue: e.TEMPORAL_TASK_QUEUE,
      },
      retrieval: {
        fusion: e.RETRIEVAL_FUSION,
        limit: e.RETRIEVAL_LIMIT,
        scoreFloor: e.RETRIEVAL_SCORE_FLOOR,
      },
      telemetry: {
        serviceName: e.OTEL_SERVICE_NAME,
        metricsPort: e.METRICS_PORT,
      },
      sources: {
        inboxDir: e.SOURCES_INBOX_DIR,
        syncIntervalMs: e.SOURCE_SYNC_INTERVAL_MS,
      },
      extraction: {
        chunkConcurrency: e.EXTRACTION_CHUNK_CONCURRENCY,
        aliasHarvestAutoApply: e.EXTRACTION_ALIAS_HARVEST_AUTO_APPLY,
        headerProposals: e.EXTRACTION_HEADER_PROPOSALS,
      },
      verifier: {
        contradictionCheck: e.VERIFY_CONTRADICTION_CHECK,
      },
      spend: {
        dailyLimitUsd: e.MODEL_SPEND_DAILY_LIMIT_USD,
        ingestDailyLimitUsd: e.MODEL_SPEND_DAILY_LIMIT_INGEST_USD,
      },
      mcp: {
        port: e.MCP_PORT,
        rateLimitPerMinute: e.MCP_RATE_LIMIT_PER_MINUTE,
        preAuthIpRateLimitWindowMs: e.MCP_PRE_AUTH_IP_RATE_LIMIT_WINDOW_MS,
        preAuthIpRateLimitMaxRequests: e.MCP_PRE_AUTH_IP_RATE_LIMIT_MAX_REQUESTS,
      },
      sse: {
        maxConnectionsPerTenant: e.SSE_MAX_CONNECTIONS_PER_TENANT,
        maxConnectionsPerUser: e.SSE_MAX_CONNECTIONS_PER_USER,
        maxStreamLifetimeMs: e.SSE_MAX_STREAM_LIFETIME_MS,
      },
      apiKeys: {
        defaultTtlDays: e.API_KEY_DEFAULT_TTL_DAYS,
      },
    };
  });

export type EnvironmentConfig = z.infer<typeof environmentSchema>;
export type AppConfig = EnvironmentConfig['app'];
export type CorsConfig = EnvironmentConfig['cors'];
export type MongoConfig = EnvironmentConfig['mongo'];
export type AuthConfig = EnvironmentConfig['auth'];
export type ThrottleConfig = EnvironmentConfig['throttle'];
export type ModelConfig = EnvironmentConfig['model'];
export type AnthropicConfig = EnvironmentConfig['anthropic'];
export type OpenAiConfig = EnvironmentConfig['openai'];
export type VoyageConfig = EnvironmentConfig['voyage'];
export type TemporalConfig = EnvironmentConfig['temporal'];
export type RetrievalConfig = EnvironmentConfig['retrieval'];
export type TelemetryConfig = EnvironmentConfig['telemetry'];
export type SourcesConfig = EnvironmentConfig['sources'];
export type ExtractionConfig = EnvironmentConfig['extraction'];
export type VerifierConfig = EnvironmentConfig['verifier'];
export type SpendConfig = EnvironmentConfig['spend'];
export type McpConfig = EnvironmentConfig['mcp'];
export type SseConfig = EnvironmentConfig['sse'];
export type ApiKeysConfig = EnvironmentConfig['apiKeys'];

/**
 * `validate` hook for `ConfigModule.forRoot`. Throws a flattened, readable error
 * listing every offending variable when the environment is invalid.
 */
export function validateEnvironment(raw: Record<string, unknown>): EnvironmentConfig {
  const parsed = environmentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}
