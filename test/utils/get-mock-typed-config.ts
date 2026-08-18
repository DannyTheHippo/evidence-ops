import type { EnvironmentConfig } from '../../src/config/environment/environment.config';
import { TypedConfigService } from '../../src/config/environment/typed-config.service';
import { getMockConfig } from './get-mock-config';

/**
 * `TypedConfigService` wraps a real `ConfigService` behind a private field, so a plain object
 * literal can't structurally satisfy it — the getters are copied straight off `getMockConfig()`
 * instead of standing up a real `ConfigService`. `overrides` merges per-namespace so a test can
 * set e.g. `anthropic: { model: 'claude-unpriced' }` without repeating the rest of the shape.
 */
export const getMockTypedConfig = (
  overrides: Partial<EnvironmentConfig> = {},
): TypedConfigService => {
  const config = { ...getMockConfig(), ...overrides };

  return {
    app: config.app,
    cors: config.cors,
    mongo: config.mongo,
    auth: config.auth,
    throttle: config.throttle,
    model: config.model,
    anthropic: config.anthropic,
    openai: config.openai,
    voyage: config.voyage,
    temporal: config.temporal,
    retrieval: config.retrieval,
    telemetry: config.telemetry,
    sources: config.sources,
    extraction: config.extraction,
    spend: config.spend,
    mcp: config.mcp,
    sse: config.sse,
    apiKeys: config.apiKeys,
  } as unknown as TypedConfigService;
};
