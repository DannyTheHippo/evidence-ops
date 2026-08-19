import { AsyncLocalStorage } from 'node:async_hooks';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import type { AlsContext } from '../../../../src/shared/types/als-context.type';
import { getMockConfig } from '../../../utils/get-mock-config';
import { getMockTypedConfig } from '../../../utils/get-mock-typed-config';

describe('AppLogger', () => {
  const mockAls = { getStore: jest.fn() } as unknown as AsyncLocalStorage<AlsContext>;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sets the cumulative levels resolved from the configured LOG_LEVEL at construction', () => {
    const setLogLevelsSpy = jest.spyOn(AppLogger.prototype, 'setLogLevels');
    const config = getMockTypedConfig({ app: { ...getMockConfig().app, logLevel: 'warn' } });

    new AppLogger(mockAls, config);

    expect(setLogLevelsSpy).toHaveBeenCalledWith(['warn', 'error', 'fatal']);
  });

  it('maps the info level to log before expanding it cumulatively', () => {
    const setLogLevelsSpy = jest.spyOn(AppLogger.prototype, 'setLogLevels');
    const config = getMockTypedConfig({ app: { ...getMockConfig().app, logLevel: 'info' } });

    new AppLogger(mockAls, config);

    expect(setLogLevelsSpy).toHaveBeenCalledWith(['log', 'warn', 'error', 'fatal']);
  });
});
