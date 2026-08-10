import type { Logger } from '@nestjs/common';

export type MockLogger = jest.Mocked<
  Partial<Logger> & {
    init: (context: string) => void;
  }
>;

export const getMockLogger = (): MockLogger => {
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
    init: jest.fn(),
  };

  return logger;
};
