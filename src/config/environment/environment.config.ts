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

const isProdLike = (nodeEnv: string): boolean => ['production', 'staging'].includes(nodeEnv);

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

    ANTHROPIC_API_KEY: zOptionalString(),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),

    VOYAGE_API_KEY: zOptionalString(),
    VOYAGE_MODEL: z.string().default('voyage-4'),
    VOYAGE_DIMENSIONS: zNumEnum(1024, [256, 512, 1024, 2048] as const),
    // Free-tier default (3 RPM, 5 retries, 5min wait budget) — the account this ships against has
    // no payment method on file and is throttled to those limits; see voyage-embedding.provider.ts.
    VOYAGE_REQUESTS_PER_MINUTE: zNum(3),
    VOYAGE_MAX_RETRIES: zNum(5),
    VOYAGE_MAX_RETRY_WAIT_MS: zNum(300_000),

    TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    TEMPORAL_TASK_QUEUE: z.string().default('evidence-ops'),

    RETRIEVAL_FUSION: z.enum(['server', 'app']).default('server'),
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
    const mongoUri = e.MONGO_DB_URI ?? 'mongodb://localhost:27017/evidence-ops';
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
      anthropic: {
        apiKey: e.ANTHROPIC_API_KEY,
        model: e.ANTHROPIC_MODEL,
      },
      voyage: {
        apiKey: e.VOYAGE_API_KEY,
        model: e.VOYAGE_MODEL,
        dimensions: e.VOYAGE_DIMENSIONS,
        requestsPerMinute: e.VOYAGE_REQUESTS_PER_MINUTE,
        maxRetries: e.VOYAGE_MAX_RETRIES,
        maxRetryWaitMs: e.VOYAGE_MAX_RETRY_WAIT_MS,
      },
      temporal: {
        address: e.TEMPORAL_ADDRESS,
        namespace: e.TEMPORAL_NAMESPACE,
        taskQueue: e.TEMPORAL_TASK_QUEUE,
      },
      retrieval: {
        fusion: e.RETRIEVAL_FUSION,
      },
    };
  });

export type EnvironmentConfig = z.infer<typeof environmentSchema>;
export type AppConfig = EnvironmentConfig['app'];
export type CorsConfig = EnvironmentConfig['cors'];
export type MongoConfig = EnvironmentConfig['mongo'];
export type AuthConfig = EnvironmentConfig['auth'];
export type ThrottleConfig = EnvironmentConfig['throttle'];
export type AnthropicConfig = EnvironmentConfig['anthropic'];
export type VoyageConfig = EnvironmentConfig['voyage'];
export type TemporalConfig = EnvironmentConfig['temporal'];
export type RetrievalConfig = EnvironmentConfig['retrieval'];

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
