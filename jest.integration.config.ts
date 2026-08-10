import type { Config } from 'jest';

/**
 * Separate from `jest.config.ts` (unit, socketless) and `jest.e2e.config.ts` (Nest app over
 * `mongodb-memory-server`) because these specs need a real `mongodb/mongodb-atlas-local`
 * container — `$search`/`$vectorSearch` index builds are not something `mongodb-memory-server`
 * can serve. Matched by `*.integration-spec.ts`, run only via `npm run test:integration`, never
 * by the default `npm test` (`testRegex` there is `.spec.ts$`, which this suffix does not hit)
 * and never by CI, which has no Docker.
 */
const config: Config = {
  testEnvironment: 'node',
  testTimeout: 300000,
  passWithNoTests: false,
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.integration-spec\\.ts$',
  transform: {
    '^.+\\.[tj]s$': 'ts-jest',
  },
  watchPathIgnorePatterns: ['node_modules', 'dist'],
  testPathIgnorePatterns: ['node_modules', 'dist'],
};

export default config;
