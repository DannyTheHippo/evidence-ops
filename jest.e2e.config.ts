import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  testTimeout: 60000,
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
