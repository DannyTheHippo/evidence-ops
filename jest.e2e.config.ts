import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  testTimeout: 60000,
  // Each worker boots its own `mongodb-memory-server` mongod AND a full Nest application, so the
  // per-worker cost here is far higher than in the unit lane. Uncapped (jest's cpus-1 default) that
  // contention surfaces as transport-level failures — a dropped connection reported as `socket hang
  // up`, or a request that never reaches a route — rather than as an assertion failure, which makes
  // it read like a product bug instead of resource pressure.
  maxWorkers: 2,
  passWithNoTests: false,
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: './test',
  testRegex: '.*\\.e2e-spec\\.ts$',
  setupFiles: ['<rootDir>/e2e/setup-env.ts'],
  transform: {
    '^.+\\.[tj]s$': 'ts-jest',
  },
  watchPathIgnorePatterns: ['node_modules', 'dist'],
  testPathIgnorePatterns: ['node_modules', 'dist'],
};

export default config;
