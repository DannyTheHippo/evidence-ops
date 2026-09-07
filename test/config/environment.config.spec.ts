import {
  RETRIEVAL_MAX_PIPELINE_WEIGHT,
  RETRIEVAL_PIPELINE_COUNT,
  RETRIEVAL_RRF_K,
  validateEnvironment,
} from '../../src/config/environment/environment.config';
import {
  PIPELINE_NAMES,
  PIPELINE_WEIGHTS,
  RRF_K,
} from '../../src/providers/retrieval/mongo-hybrid.store';
import { NodeEnv } from '../../src/shared/enums/global/node-env.enum';

const validEnv: Record<string, unknown> = {
  NODE_ENV: 'development',
  PORT: '4000',
  LOG_LEVEL: 'debug',
  URL: 'http://localhost:4000',
  CORS_ORIGIN: 'http://localhost:5173',
  MONGO_DB_URI: 'mongodb://localhost:27017/test',
  MONGO_MEMORY_SERVER: 'true',
  JWT_SECRET: 'test-secret',
  JWT_EXPIRES_IN: '7d',
  THROTTLE_TTL_MS: '60000',
  THROTTLE_LIMIT: '100',
};

describe('validateEnvironment', () => {
  describe('defaults', () => {
    it('applies schema defaults when vars are unset in a non-prod environment', () => {
      const result = validateEnvironment({});

      expect(result.app.env).toBe(NodeEnv.DEVELOPMENT);
      expect(result.app.port).toBe(3000);
      expect(result.app.logLevel).toBe('info');
      expect(result.app.url).toBe('http://localhost:3000');
      expect(result.app.trustProxyHops).toBe(0);
      expect(result.mongo.uri).toBe('mongodb://localhost:27018/evidence-ops?directConnection=true');
      expect(result.auth.jwtSecret).toBe('dev-only-insecure-jwt-secret');
      expect(result.throttle.ttlMs).toBe(60000);
      expect(result.throttle.limit).toBe(100);
      expect(result.mcp.port).toBe(3002);
      expect(result.mcp.rateLimitPerMinute).toBe(60);
      expect(result.mcp.preAuthIpRateLimitWindowMs).toBe(60000);
      expect(result.mcp.preAuthIpRateLimitMaxRequests).toBe(20);
      expect(result.sse.maxConnectionsPerTenant).toBe(100);
      expect(result.sse.maxConnectionsPerUser).toBe(10);
      expect(result.sse.maxStreamLifetimeMs).toBe(1_800_000);
      expect(result.apiKeys.defaultTtlDays).toBe(90);
    });
  });

  describe('required vars in prod-like environments', () => {
    it('throws listing MONGO_DB_URI and JWT_SECRET when unset with NODE_ENV=production', () => {
      const env: Record<string, unknown> = {
        ...validEnv,
        NODE_ENV: 'production',
        MONGO_DB_URI: '',
        JWT_SECRET: '',
      };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/MONGO_DB_URI/);
      expect(() => validateEnvironment(env)).toThrow(/JWT_SECRET/);
    });

    it('does not require MONGO_DB_URI/JWT_SECRET when NODE_ENV is not prod-like', () => {
      const env: Record<string, unknown> = {
        ...validEnv,
        NODE_ENV: 'development',
        MONGO_DB_URI: '',
        JWT_SECRET: '',
      };

      expect(() => validateEnvironment(env)).not.toThrow();
    });

    // Regression: a blank `JWT_SECRET=""` in .env used to survive `?? default` (which only
    // catches null/undefined) and reach JwtModule as an empty secret — jsonwebtoken then threw
    // on sign, so register worked and login 500'd. Asserting "does not throw" above was not
    // enough; the resulting VALUE is what matters.
    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
    ])('substitutes dev defaults when vars are %s below prod-like', (_label, blank) => {
      const result = validateEnvironment({
        ...validEnv,
        NODE_ENV: 'development',
        MONGO_DB_URI: blank,
        JWT_SECRET: blank,
      });

      expect(result.auth.jwtSecret).toBe('dev-only-insecure-jwt-secret');
      expect(result.mongo.uri).toBe('mongodb://localhost:27018/evidence-ops?directConnection=true');
    });

    it('rejects a whitespace-only JWT_SECRET in a prod-like environment', () => {
      const env: Record<string, unknown> = {
        ...validEnv,
        NODE_ENV: 'production',
        JWT_SECRET: '  ',
      };

      expect(() => validateEnvironment(env)).toThrow(/JWT_SECRET/);
    });

    it('trims surrounding whitespace off configured secrets', () => {
      const result = validateEnvironment({
        ...validEnv,
        NODE_ENV: 'staging',
        JWT_SECRET: '  real-secret  ',
      });

      expect(result.auth.jwtSecret).toBe('real-secret');
    });

    it('passes when MONGO_DB_URI and JWT_SECRET are set with NODE_ENV=staging', () => {
      const env: Record<string, unknown> = { ...validEnv, NODE_ENV: 'staging' };

      const result = validateEnvironment(env);

      expect(result.app.env).toBe(NodeEnv.STAGING);
      expect(result.mongo.uri).toBe(validEnv.MONGO_DB_URI);
    });
  });

  describe('type coercion', () => {
    it('coerces PORT from string to number', () => {
      const env: Record<string, unknown> = { ...validEnv, PORT: '4321' };

      const result = validateEnvironment(env);

      expect(result.app.port).toBe(4321);
      expect(typeof result.app.port).toBe('number');
    });

    it('coerces MONGO_MEMORY_SERVER "true"/"false" to boolean', () => {
      expect(
        validateEnvironment({ ...validEnv, MONGO_MEMORY_SERVER: 'true' }).mongo.memoryServer,
      ).toBe(true);
      expect(
        validateEnvironment({ ...validEnv, MONGO_MEMORY_SERVER: 'false' }).mongo.memoryServer,
      ).toBe(false);
    });

    it('coerces MONGO_MEMORY_SERVER "yes" to true via zBool', () => {
      const env: Record<string, unknown> = { ...validEnv, MONGO_MEMORY_SERVER: 'yes' };

      expect(validateEnvironment(env).mongo.memoryServer).toBe(true);
    });

    it('throws when PORT is set to a non-numeric value', () => {
      const env: Record<string, unknown> = { ...validEnv, PORT: 'not-a-number' };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
    });

    it('coerces TRUST_PROXY_HOPS from string to number', () => {
      const env: Record<string, unknown> = { ...validEnv, TRUST_PROXY_HOPS: '1' };

      const result = validateEnvironment(env);

      expect(result.app.trustProxyHops).toBe(1);
      expect(typeof result.app.trustProxyHops).toBe('number');
    });
  });

  describe('LOG_LEVEL', () => {
    it.each(['fatal', 'error', 'warn', 'log', 'info', 'debug', 'verbose'])(
      'accepts %s',
      (level) => {
        const result = validateEnvironment({ ...validEnv, LOG_LEVEL: level });

        expect(result.app.logLevel).toBe(level);
      },
    );

    it('rejects an unknown LOG_LEVEL value', () => {
      const env: Record<string, unknown> = { ...validEnv, LOG_LEVEL: 'lodebug' };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/LOG_LEVEL/);
    });
  });

  describe('namespacing shape', () => {
    it('returns a config object namespaced by app/cors/mongo/auth', () => {
      const result = validateEnvironment(validEnv);

      expect(Object.keys(result).sort()).toEqual(
        [
          'app',
          'cors',
          'mongo',
          'auth',
          'throttle',
          'model',
          'anthropic',
          'openai',
          'voyage',
          'embedding',
          'openaiCompatible',
          'temporal',
          'retrieval',
          'telemetry',
          'sources',
          'extraction',
          'verifier',
          'spend',
          'mcp',
          'sse',
          'apiKeys',
        ].sort(),
      );
    });
  });

  describe('AI provider / temporal / retrieval config', () => {
    it('applies defaults when the vars are unset', () => {
      const result = validateEnvironment({});

      expect(result.model.provider).toBe('anthropic');
      expect(result.anthropic.apiKey).toBeUndefined();
      expect(result.anthropic.model).toBe('claude-sonnet-5');
      expect(result.anthropic.timeoutMs).toBe(60000);
      expect(result.openai.apiKey).toBeUndefined();
      expect(result.openai.model).toBe('gpt-5');
      expect(result.openai.baseUrl).toBe('https://api.openai.com/v1');
      expect(result.openai.timeoutMs).toBe(60000);
      expect(result.voyage.apiKey).toBeUndefined();
      expect(result.voyage.model).toBe('voyage-4');
      expect(result.voyage.dimensions).toBe(1024);
      expect(result.voyage.requestTimeoutMs).toBe(30000);
      expect(result.embedding.provider).toBe('voyage');
      expect(result.embedding.dimensions).toBe(1024);
      expect(result.openaiCompatible.apiKey).toBeUndefined();
      expect(result.openaiCompatible.baseUrl).toBe('http://localhost:11434/v1');
      expect(result.openaiCompatible.model).toBe('llama3.1:8b');
      expect(result.openaiCompatible.embeddingModel).toBe('mxbai-embed-large');
      expect(result.openaiCompatible.timeoutMs).toBe(60000);
      expect(result.openaiCompatible.structuredOutput).toBe('json_schema');
      expect(result.openaiCompatible.priceInputUsdPerMtok).toBeUndefined();
      expect(result.openaiCompatible.priceOutputUsdPerMtok).toBeUndefined();
      expect(result.openaiCompatible.embeddingPriceUsdPerMtok).toBeUndefined();
      expect(result.temporal.address).toBe('localhost:7233');
      expect(result.temporal.namespace).toBe('default');
      expect(result.temporal.taskQueue).toBe('evidence-ops');
      expect(result.temporal.maxConcurrentActivityTaskExecutions).toBe(4);
      expect(result.retrieval.fusion).toBe('server');
      expect(result.retrieval.limit).toBe(12);
      // Ships inert: the real value comes from a deferred corpus run. Asserted against the
      // schema default itself (RETRIEVAL_SCORE_FLOOR is unset above), not a test fixture's own
      // default, so this fails the moment that default changes.
      expect(result.retrieval.scoreFloor).toBe(0);
      expect(result.extraction.chunkConcurrency).toBe(2);
      expect(result.spend.dailyLimitUsd).toBe(50);
    });

    it('coerces ANTHROPIC_TIMEOUT_MS, OPENAI_TIMEOUT_MS, VOYAGE_REQUEST_TIMEOUT_MS, and MODEL_SPEND_DAILY_LIMIT_USD from string to number', () => {
      const result = validateEnvironment({
        ...validEnv,
        ANTHROPIC_TIMEOUT_MS: '45000',
        OPENAI_TIMEOUT_MS: '20000',
        VOYAGE_REQUEST_TIMEOUT_MS: '15000',
        MODEL_SPEND_DAILY_LIMIT_USD: '100',
      });

      expect(result.anthropic.timeoutMs).toBe(45000);
      expect(result.openai.timeoutMs).toBe(20000);
      expect(result.voyage.requestTimeoutMs).toBe(15000);
      expect(result.spend.dailyLimitUsd).toBe(100);
    });

    it('coerces RETRIEVAL_LIMIT and EXTRACTION_CHUNK_CONCURRENCY from string to number', () => {
      const result = validateEnvironment({
        ...validEnv,
        RETRIEVAL_LIMIT: '20',
        EXTRACTION_CHUNK_CONCURRENCY: '4',
      });

      expect(result.retrieval.limit).toBe(20);
      expect(result.extraction.chunkConcurrency).toBe(4);
    });

    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
    ])(
      'normalises %s ANTHROPIC_API_KEY/OPENAI_API_KEY/VOYAGE_API_KEY to undefined',
      (_label, blank) => {
        const result = validateEnvironment({
          ...validEnv,
          ANTHROPIC_API_KEY: blank,
          OPENAI_API_KEY: blank,
          VOYAGE_API_KEY: blank,
        });

        expect(result.anthropic.apiKey).toBeUndefined();
        expect(result.openai.apiKey).toBeUndefined();
        expect(result.voyage.apiKey).toBeUndefined();
      },
    );

    it('accepts each legal Matryoshka dimension', () => {
      for (const dimensions of [256, 512, 1024, 2048]) {
        const result = validateEnvironment({
          ...validEnv,
          VOYAGE_DIMENSIONS: String(dimensions),
          // EMBEDDING_DIMENSIONS must agree with VOYAGE_DIMENSIONS under the default
          // EMBEDDING_PROVIDER ('voyage') — see the EMBEDDING_DIMENSIONS describe block below.
          EMBEDDING_DIMENSIONS: String(dimensions),
        });

        expect(result.voyage.dimensions).toBe(dimensions);
      }
    });

    it('rejects a VOYAGE_DIMENSIONS value outside the legal Matryoshka set', () => {
      const env: Record<string, unknown> = { ...validEnv, VOYAGE_DIMENSIONS: '768' };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/VOYAGE_DIMENSIONS/);
    });

    it('rejects an unknown RETRIEVAL_FUSION value', () => {
      const env: Record<string, unknown> = { ...validEnv, RETRIEVAL_FUSION: 'client' };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/RETRIEVAL_FUSION/);
    });

    it('accepts the app fusion strategy', () => {
      const result = validateEnvironment({ ...validEnv, RETRIEVAL_FUSION: 'app' });

      expect(result.retrieval.fusion).toBe('app');
    });

    describe('RETRIEVAL_SCORE_FLOOR', () => {
      // Mirrors the ceiling `environment.config.ts` derives from the retrieval store's fusion
      // formula: two equally weighted pipelines, RRF_K=60, best rank 1 each.
      const RRF_SCORE_CEILING = 2 / 61;

      it('accepts a value at the RRF score ceiling', () => {
        const result = validateEnvironment({
          ...validEnv,
          RETRIEVAL_SCORE_FLOOR: String(RRF_SCORE_CEILING),
        });

        expect(result.retrieval.scoreFloor).toBeCloseTo(RRF_SCORE_CEILING);
      });

      it('refuses to boot with a RETRIEVAL_SCORE_FLOOR above the RRF score ceiling, naming the real scale', () => {
        const env: Record<string, unknown> = { ...validEnv, RETRIEVAL_SCORE_FLOOR: '0.5' };

        expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
        expect(() => validateEnvironment(env)).toThrow(/RETRIEVAL_SCORE_FLOOR/);
        expect(() => validateEnvironment(env)).toThrow(/RRF_K=60/);
      });
    });

    describe('retrieval score ceiling constants track the store', () => {
      // `RETRIEVAL_SCORE_CEILING` is hand-derived from `mongo-hybrid.store.ts`'s fusion constants
      // because importing that module here would be circular (see the comment at the constants'
      // definition). This is the guard that comment promises: it fails the moment either side
      // changes without the other.
      it('mirrors PIPELINE_NAMES.length, the max of PIPELINE_WEIGHTS, and RRF_K', () => {
        expect(RETRIEVAL_PIPELINE_COUNT).toBe(PIPELINE_NAMES.length);
        expect(RETRIEVAL_MAX_PIPELINE_WEIGHT).toBe(Math.max(...Object.values(PIPELINE_WEIGHTS)));
        expect(RETRIEVAL_RRF_K).toBe(RRF_K);
      });
    });

    it('rejects an unknown MODEL_PROVIDER value', () => {
      const env: Record<string, unknown> = { ...validEnv, MODEL_PROVIDER: 'azure' };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/MODEL_PROVIDER/);
    });

    it('accepts MODEL_PROVIDER=openai and applies the OPENAI_BASE_URL override', () => {
      const result = validateEnvironment({
        ...validEnv,
        MODEL_PROVIDER: 'openai',
        OPENAI_BASE_URL: 'https://openai.internal.example/v1',
      });

      expect(result.model.provider).toBe('openai');
      expect(result.openai.baseUrl).toBe('https://openai.internal.example/v1');
    });
  });

  describe('EMBEDDING_PROVIDER / EMBEDDING_DIMENSIONS / OPENAI_COMPATIBLE_* / TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASKS', () => {
    it('rejects an unknown EMBEDDING_PROVIDER value', () => {
      const env: Record<string, unknown> = { ...validEnv, EMBEDDING_PROVIDER: 'azure' };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/EMBEDDING_PROVIDER/);
    });

    it('refuses when EMBEDDING_DIMENSIONS disagrees with VOYAGE_DIMENSIONS under the voyage embedding provider', () => {
      const env: Record<string, unknown> = {
        ...validEnv,
        EMBEDDING_PROVIDER: 'voyage',
        VOYAGE_DIMENSIONS: '1024',
        EMBEDDING_DIMENSIONS: '512',
      };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/EMBEDDING_DIMENSIONS/);
    });

    it('accepts EMBEDDING_DIMENSIONS equal to VOYAGE_DIMENSIONS', () => {
      const result = validateEnvironment({
        ...validEnv,
        EMBEDDING_PROVIDER: 'voyage',
        VOYAGE_DIMENSIONS: '2048',
        EMBEDDING_DIMENSIONS: '2048',
      });

      expect(result.embedding.dimensions).toBe(2048);
    });

    it('rejects a non-integer EMBEDDING_DIMENSIONS', () => {
      const env: Record<string, unknown> = { ...validEnv, EMBEDDING_DIMENSIONS: '3.5' };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/EMBEDDING_DIMENSIONS/);
    });

    it('rejects a non-URL OPENAI_COMPATIBLE_BASE_URL', () => {
      const env: Record<string, unknown> = { ...validEnv, OPENAI_COMPATIBLE_BASE_URL: 'not-a-url' };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/OPENAI_COMPATIBLE_BASE_URL/);
    });

    it('rejects a zero TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASKS', () => {
      const env: Record<string, unknown> = {
        ...validEnv,
        TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASKS: '0',
      };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASKS/);
    });

    it('coerces TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASKS from string to number', () => {
      const result = validateEnvironment({
        ...validEnv,
        TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASKS: '8',
      });

      expect(result.temporal.maxConcurrentActivityTaskExecutions).toBe(8);
    });

    describe('MODEL_PROVIDER=openai-compatible model price refusal', () => {
      it('refuses to boot without OPENAI_COMPATIBLE_PRICE_INPUT_USD_PER_MTOK/…_OUTPUT_…', () => {
        const env: Record<string, unknown> = { ...validEnv, MODEL_PROVIDER: 'openai-compatible' };

        expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
        expect(() => validateEnvironment(env)).toThrow(
          /OPENAI_COMPATIBLE_PRICE_INPUT_USD_PER_MTOK/,
        );
        expect(() => validateEnvironment(env)).toThrow(
          /OPENAI_COMPATIBLE_PRICE_OUTPUT_USD_PER_MTOK/,
        );
      });

      it('accepts MODEL_PROVIDER=openai-compatible with both model prices set, including an explicit 0', () => {
        const result = validateEnvironment({
          ...validEnv,
          MODEL_PROVIDER: 'openai-compatible',
          OPENAI_COMPATIBLE_PRICE_INPUT_USD_PER_MTOK: '0',
          OPENAI_COMPATIBLE_PRICE_OUTPUT_USD_PER_MTOK: '0.5',
        });

        expect(result.openaiCompatible.priceInputUsdPerMtok).toBe(0);
        expect(result.openaiCompatible.priceOutputUsdPerMtok).toBe(0.5);
      });

      it('refuses a negative OPENAI_COMPATIBLE_PRICE_INPUT_USD_PER_MTOK', () => {
        const env: Record<string, unknown> = {
          ...validEnv,
          OPENAI_COMPATIBLE_PRICE_INPUT_USD_PER_MTOK: '-1',
        };

        expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
        expect(() => validateEnvironment(env)).toThrow(
          /OPENAI_COMPATIBLE_PRICE_INPUT_USD_PER_MTOK/,
        );
      });
    });

    describe('EMBEDDING_PROVIDER=openai-compatible embedding price refusal', () => {
      it('refuses to boot without OPENAI_COMPATIBLE_EMBEDDING_PRICE_USD_PER_MTOK', () => {
        const env: Record<string, unknown> = {
          ...validEnv,
          EMBEDDING_PROVIDER: 'openai-compatible',
        };

        expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
        expect(() => validateEnvironment(env)).toThrow(
          /OPENAI_COMPATIBLE_EMBEDDING_PRICE_USD_PER_MTOK/,
        );
      });

      it('accepts EMBEDDING_PROVIDER=openai-compatible with an explicit 0 embedding price', () => {
        const result = validateEnvironment({
          ...validEnv,
          EMBEDDING_PROVIDER: 'openai-compatible',
          OPENAI_COMPATIBLE_EMBEDDING_PRICE_USD_PER_MTOK: '0',
        });

        expect(result.openaiCompatible.embeddingPriceUsdPerMtok).toBe(0);
      });
    });
  });

  describe('VERIFY_CONTRADICTION_CHECK', () => {
    it('defaults to false when unset', () => {
      const result = validateEnvironment({});

      expect(result.verifier.contradictionCheck).toBe(false);
    });

    it('parses "true" to true', () => {
      const result = validateEnvironment({ ...validEnv, VERIFY_CONTRADICTION_CHECK: 'true' });

      expect(result.verifier.contradictionCheck).toBe(true);
    });
  });

  describe('SSE caps, the MCP pre-auth IP limiter, and the API key default TTL', () => {
    it('coerces MCP_PRE_AUTH_IP_RATE_LIMIT_WINDOW_MS/MAX_REQUESTS from string to number', () => {
      const result = validateEnvironment({
        ...validEnv,
        MCP_PRE_AUTH_IP_RATE_LIMIT_WINDOW_MS: '30000',
        MCP_PRE_AUTH_IP_RATE_LIMIT_MAX_REQUESTS: '5',
      });

      expect(result.mcp.preAuthIpRateLimitWindowMs).toBe(30000);
      expect(result.mcp.preAuthIpRateLimitMaxRequests).toBe(5);
    });

    it('coerces SSE_MAX_CONNECTIONS_PER_TENANT/PER_USER/SSE_MAX_STREAM_LIFETIME_MS from string to number', () => {
      const result = validateEnvironment({
        ...validEnv,
        SSE_MAX_CONNECTIONS_PER_TENANT: '250',
        SSE_MAX_CONNECTIONS_PER_USER: '20',
        SSE_MAX_STREAM_LIFETIME_MS: '900000',
      });

      expect(result.sse.maxConnectionsPerTenant).toBe(250);
      expect(result.sse.maxConnectionsPerUser).toBe(20);
      expect(result.sse.maxStreamLifetimeMs).toBe(900000);
    });

    it('coerces API_KEY_DEFAULT_TTL_DAYS from string to number', () => {
      const result = validateEnvironment({ ...validEnv, API_KEY_DEFAULT_TTL_DAYS: '30' });

      expect(result.apiKeys.defaultTtlDays).toBe(30);
    });

    it('rejects a non-numeric MCP_PRE_AUTH_IP_RATE_LIMIT_MAX_REQUESTS', () => {
      const env: Record<string, unknown> = {
        ...validEnv,
        MCP_PRE_AUTH_IP_RATE_LIMIT_MAX_REQUESTS: 'not-a-number',
      };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/MCP_PRE_AUTH_IP_RATE_LIMIT_MAX_REQUESTS/);
    });

    it('rejects a non-numeric SSE_MAX_STREAM_LIFETIME_MS', () => {
      const env: Record<string, unknown> = {
        ...validEnv,
        SSE_MAX_STREAM_LIFETIME_MS: 'not-a-number',
      };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/SSE_MAX_STREAM_LIFETIME_MS/);
    });

    it('rejects a non-numeric API_KEY_DEFAULT_TTL_DAYS', () => {
      const env: Record<string, unknown> = {
        ...validEnv,
        API_KEY_DEFAULT_TTL_DAYS: 'not-a-number',
      };

      expect(() => validateEnvironment(env)).toThrow(/Invalid environment configuration/);
      expect(() => validateEnvironment(env)).toThrow(/API_KEY_DEFAULT_TTL_DAYS/);
    });
  });
});
