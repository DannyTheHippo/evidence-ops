import type { LogLevel } from '@nestjs/common';
import type { AppConfig } from '../../config/environment/environment.config';

// `ConsoleLogger`'s own severity ordering, least to most severe.
const SEVERITY_ORDER: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

/**
 * Expands a configured `LOG_LEVEL` into the cumulative array `ConsoleLogger.setLogLevels`
 * expects — every level at or above the configured severity, not the configured level alone.
 * `info` maps to Nest's `log`, since Nest's `LogLevel` union has no `info` member.
 */
export const resolveLogLevels = (level: AppConfig['logLevel']): LogLevel[] => {
  const nestLevel: LogLevel = level === 'info' ? 'log' : level;
  const floorIndex = SEVERITY_ORDER.indexOf(nestLevel);

  return SEVERITY_ORDER.slice(floorIndex);
};
