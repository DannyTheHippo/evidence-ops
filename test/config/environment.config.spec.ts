import { validateEnvironment } from '../../src/config/environment/environment.config';
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
      expect(result.mongo.uri).toBe('mongodb://localhost:27018/evidence-ops?directConnection=true');
      expect(result.auth.jwtSecret).toBe('dev-only-insecure-jwt-secret');
      expect(result.throttle.ttlMs).toBe(60000);
      expect(result.throttle.limit).toBe(100);
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
          'anthropic',
          'voyage',
          'temporal',
          'retrieval',
          'telemetry',
          'sources',
        ].sort(),
      );
    });
  });

  describe('AI provider / temporal / retrieval config', () => {
    it('applies defaults when the vars are unset', () => {
      const result = validateEnvironment({});

      expect(result.anthropic.apiKey).toBeUndefined();
      expect(result.anthropic.model).toBe('claude-sonnet-5');
      expect(result.voyage.apiKey).toBeUndefined();
      expect(result.voyage.model).toBe('voyage-4');
      expect(result.voyage.dimensions).toBe(1024);
      expect(result.temporal.address).toBe('localhost:7233');
      expect(result.temporal.namespace).toBe('default');
      expect(result.temporal.taskQueue).toBe('evidence-ops');
      expect(result.retrieval.fusion).toBe('server');
    });

    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
    ])('normalises %s ANTHROPIC_API_KEY/VOYAGE_API_KEY to undefined', (_label, blank) => {
      const result = validateEnvironment({
        ...validEnv,
        ANTHROPIC_API_KEY: blank,
        VOYAGE_API_KEY: blank,
      });

      expect(result.anthropic.apiKey).toBeUndefined();
      expect(result.voyage.apiKey).toBeUndefined();
    });

    it('accepts each legal Matryoshka dimension', () => {
      for (const dimensions of [256, 512, 1024, 2048]) {
        const result = validateEnvironment({ ...validEnv, VOYAGE_DIMENSIONS: String(dimensions) });

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
  });
});
