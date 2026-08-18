import { z } from 'zod';

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

// Exported so callers outside this module (the login cookie's `Secure`/`__Host-` decision) share
// the one predicate that also gates the MONGO_DB_URI/JWT_SECRET requirement below — a fourth
// prod-like environment added only here must not silently ship an insecure cookie elsewhere.
export const isProdLike = (nodeEnv: string): boolean => ['production', 'staging'].includes(nodeEnv);

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
    LOG_LEVEL: z.string().default('info'),
    URL: z.string().default('http://localhost:3000'),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),

    MONGO_DB_URI: zOptionalString(),
    MONGO_MEMORY_SERVER: zBool(false),

    JWT_SECRET: zOptionalString(),
    JWT_EXPIRES_IN: z.string().default('7d'),

    THROTTLE_TTL_MS: zNum(60000),
    THROTTLE_LIMIT: zNum(100),

    // 'anthropic' | 'openai' selects which base ModelProvider providers.module.ts wires behind
    // the standing Tracing(Caching(SpendGuard(base))) chain.
    MODEL_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),

    ANTHROPIC_API_KEY: zOptionalString(),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
    ANTHROPIC_TIMEOUT_MS: zNum(60_000),

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
    VOYAGE_MAX_RETRIES: zNum(5),
    VOYAGE_MAX_RETRY_WAIT_MS: zNum(300_000),
    VOYAGE_REQUEST_TIMEOUT_MS: zNum(30_000),

    TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    TEMPORAL_TASK_QUEUE: z.string().default('evidence-ops'),

    RETRIEVAL_FUSION: z.enum(['server', 'app']).default('server'),
    RETRIEVAL_LIMIT: zNum(12),

    EXTRACTION_CHUNK_CONCURRENCY: zNum(2),

    /** Per-tenant aggregate daily ceiling on model spend, in USD. A value `<= 0` disables the ceiling entirely. */
    MODEL_SPEND_DAILY_LIMIT_USD: zNum(50),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),
    // Dev-only, OFF by default: attaches prompt/completion text as span *events* (never
    // attributes — see `docs/global/threat-model.md` residual risks). Evidence text reaching a trace
    // backend is document content leaving the trust boundary; only turn this on locally against
    // a trace backend you control.
    OTEL_CAPTURE_MODEL_CONTENT: zBool(false),
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
    // port already in use in this stack (mongo host-mapped 27018, jaeger/OTLP 4318, temporal UI
    // 8233, web 8090, qdrant 6333) — the MCP process is a third HTTP-listening process alongside
    // the API.
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
    if (!isProdLike(e.NODE_ENV)) {
      return;
    }

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
      },
      telemetry: {
        otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
        captureModelContent: e.OTEL_CAPTURE_MODEL_CONTENT,
        serviceName: e.OTEL_SERVICE_NAME,
        metricsPort: e.METRICS_PORT,
      },
      sources: {
        inboxDir: e.SOURCES_INBOX_DIR,
        syncIntervalMs: e.SOURCE_SYNC_INTERVAL_MS,
      },
      extraction: {
        chunkConcurrency: e.EXTRACTION_CHUNK_CONCURRENCY,
      },
      spend: {
        dailyLimitUsd: e.MODEL_SPEND_DAILY_LIMIT_USD,
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
