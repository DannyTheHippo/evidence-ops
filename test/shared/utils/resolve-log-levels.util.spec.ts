import { resolveLogLevels } from '../../../src/shared/utils/resolve-log-levels.util';

describe('resolveLogLevels', () => {
  it('maps info to log and expands to every level at or above it', () => {
    expect(resolveLogLevels('info')).toEqual(['log', 'warn', 'error', 'fatal']);
  });

  it('expands warn to warn, error, and fatal — not warn alone', () => {
    expect(resolveLogLevels('warn')).toEqual(['warn', 'error', 'fatal']);
  });

  it('expands verbose to every level, since verbose is the lowest severity', () => {
    expect(resolveLogLevels('verbose')).toEqual([
      'verbose',
      'debug',
      'log',
      'warn',
      'error',
      'fatal',
    ]);
  });

  it('expands fatal to fatal alone, since fatal is the highest severity', () => {
    expect(resolveLogLevels('fatal')).toEqual(['fatal']);
  });

  it.each([
    ['debug', ['debug', 'log', 'warn', 'error', 'fatal']],
    ['log', ['log', 'warn', 'error', 'fatal']],
    ['error', ['error', 'fatal']],
  ])('expands %s to the cumulative array %j', (level, expected) => {
    expect(resolveLogLevels(level as Parameters<typeof resolveLogLevels>[0])).toEqual(expected);
  });
});
