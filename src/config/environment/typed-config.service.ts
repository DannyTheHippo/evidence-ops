import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AnthropicConfig,
  AppConfig,
  AuthConfig,
  CorsConfig,
  EnvironmentConfig,
  ExtractionConfig,
  McpConfig,
  ModelConfig,
  MongoConfig,
  OpenAiConfig,
  RetrievalConfig,
  SourcesConfig,
  SpendConfig,
  TelemetryConfig,
  TemporalConfig,
  ThrottleConfig,
  VoyageConfig,
} from './environment.config';

/**
 * Thin typed facade over `ConfigService` so callers read a namespace
 * (`config.auth.jwtSecret`) instead of stringly-typed `get(...)` calls.
 */
@Injectable()
export class TypedConfigService {
  constructor(private readonly config: ConfigService<EnvironmentConfig, true>) {}

  get app(): AppConfig {
    return this.config.get('app', { infer: true });
  }
  get cors(): CorsConfig {
    return this.config.get('cors', { infer: true });
  }
  get mongo(): MongoConfig {
    return this.config.get('mongo', { infer: true });
  }
  get auth(): AuthConfig {
    return this.config.get('auth', { infer: true });
  }
  get throttle(): ThrottleConfig {
    return this.config.get('throttle', { infer: true });
  }
  get model(): ModelConfig {
    return this.config.get('model', { infer: true });
  }
  get anthropic(): AnthropicConfig {
    return this.config.get('anthropic', { infer: true });
  }
  get openai(): OpenAiConfig {
    return this.config.get('openai', { infer: true });
  }
  get voyage(): VoyageConfig {
    return this.config.get('voyage', { infer: true });
  }
  get temporal(): TemporalConfig {
    return this.config.get('temporal', { infer: true });
  }
  get retrieval(): RetrievalConfig {
    return this.config.get('retrieval', { infer: true });
  }
  get telemetry(): TelemetryConfig {
    return this.config.get('telemetry', { infer: true });
  }
  get sources(): SourcesConfig {
    return this.config.get('sources', { infer: true });
  }
  get extraction(): ExtractionConfig {
    return this.config.get('extraction', { infer: true });
  }
  get spend(): SpendConfig {
    return this.config.get('spend', { infer: true });
  }
  get mcp(): McpConfig {
    return this.config.get('mcp', { infer: true });
  }
}
