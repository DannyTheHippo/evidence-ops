import type { EnvironmentConfig } from '../../src/config/environment/environment.config';
import { NodeEnv } from '../../src/shared/enums/global/node-env.enum';

export const getMockConfig = (): EnvironmentConfig => ({
  app: {
    env: NodeEnv.TEST,
    port: 3000,
    logLevel: 'debug',
    url: 'http://localhost:3000',
    trustProxyHops: 0,
  },

  cors: {
    origin: 'http://localhost:5173',
  },

  mongo: {
    uri: '',
    memoryServer: true,
  },

  auth: {
    jwtSecret: 'test-jwt-secret-at-least-32-chars-0000',
    jwtExpiresIn: '7d',
    credentialWindowMs: 900_000,
    credentialIpLimit: 10,
    credentialEmailLimit: 5,
  },

  throttle: {
    ttlMs: 60000,
    limit: 100,
  },

  model: {
    provider: 'anthropic',
  },

  anthropic: {
    apiKey: undefined,
    model: 'claude-sonnet-5',
    timeoutMs: 60000,
    factExtractionModel: undefined,
  },

  openai: {
    apiKey: undefined,
    model: 'gpt-5.1',
    baseUrl: 'https://api.openai.com/v1',
    timeoutMs: 60000,
  },

  voyage: {
    apiKey: undefined,
    model: 'voyage-4',
    dimensions: 1024,
    requestsPerMinute: 3,
    queryRequestsPerMinute: 3,
    maxRetries: 5,
    maxRetryWaitMs: 300000,
    requestTimeoutMs: 30000,
  },

  temporal: {
    address: 'localhost:7233',
    namespace: 'default',
    taskQueue: 'evidence-ops',
  },

  retrieval: {
    fusion: 'server',
    limit: 12,
    scoreFloor: 0,
  },

  telemetry: {
    serviceName: undefined,
    metricsPort: 9464,
  },

  sources: {
    inboxDir: './inbox',
    syncIntervalMs: 300000,
  },

  extraction: {
    chunkConcurrency: 2,
    aliasHarvestAutoApply: false,
    headerProposals: false,
  },

  verifier: {
    contradictionCheck: false,
  },

  spend: {
    dailyLimitUsd: 50,
    ingestDailyLimitUsd: undefined,
  },

  mcp: {
    port: 3002,
    rateLimitPerMinute: 60,
    preAuthIpRateLimitWindowMs: 60000,
    preAuthIpRateLimitMaxRequests: 20,
  },

  sse: {
    maxConnectionsPerTenant: 100,
    maxConnectionsPerUser: 10,
    maxStreamLifetimeMs: 1_800_000,
  },

  apiKeys: {
    defaultTtlDays: 90,
  },
});
