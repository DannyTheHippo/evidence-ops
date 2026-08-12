import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  setupFiles: ['<rootDir>/test/setup-tz.ts'],
  transform: {
    '^.+\\.[tj]s$': 'ts-jest',
  },
  watchPathIgnorePatterns: ['node_modules', 'dist'],
  testPathIgnorePatterns: ['node_modules', 'dist'],
  collectCoverageFrom: [
    'src/**/*.service.ts',
    'src/shared/utils/**/*.ts',
    '!**/*.(config|constant|module|schema|dto|exception|error|type|enum|response|api-examples).ts',
    '!src/main.ts',
    '!src/config/**',
    '!src/shared/services/logger/logger.service.ts',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
};

export default config;
