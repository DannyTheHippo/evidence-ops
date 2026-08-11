import { Test } from '@nestjs/testing';
import { VoyageApiKeyMissingError } from '../../../src/providers/embedding/errors/voyage-api-key-missing.error';
import { VoyageRateLimitExceededError } from '../../../src/providers/embedding/errors/voyage-rate-limit-exceeded.error';
import { VoyageRequestFailedError } from '../../../src/providers/embedding/errors/voyage-request-failed.error';
import { EMBEDDING_PROVIDER } from '../../../src/providers/embedding/embedding-provider.interface';
import {
  VoyageEmbeddingProvider,
  type VoyageClock,
} from '../../../src/providers/embedding/voyage-embedding.provider';
import { TypedConfigService } from '../../../src/config/environment/typed-config.service';
import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

interface VoyageRequestBody {
  readonly input: string[];
  readonly input_type: string;
}

/** Full `voyage` namespace defaults for a configured provider; tests override only what they need. */
const DEFAULT_VOYAGE_CONFIG = {
  apiKey: 'voyage-key',
  model: 'voyage-4',
  dimensions: 1024 as const,
  requestsPerMinute: 3,
  maxRetries: 5,
  maxRetryWaitMs: 300_000,
};

function buildResponse(inputs: readonly string[]): Response {
  const body = {
    data: inputs.map((_, index) => ({ embedding: [index], index })),
    usage: { total_tokens: inputs.length * 2 },
  };

  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function buildFailedResponse(
  status: number,
  body: string,
  retryAfter: string | null = null,
): Response {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
    json: () => Promise.reject(new Error('not called')),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * An instant, deterministic stand-in for `VoyageClock` — `sleep` resolves immediately but still
 * advances the virtual clock `now()` reads, so pacing/backoff math produces real millisecond
 * values without a test ever waiting in real time. `sleepCalls` records every requested delay for
 * assertions.
 */
function createVirtualClock(): VoyageClock & { sleepCalls: number[] } {
  let virtualNow = 0;
  const sleepCalls: number[] = [];

  return {
    now: () => virtualNow,
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      virtualNow += ms;
      return Promise.resolve();
    },
    sleepCalls,
  };
}

describe('VoyageEmbeddingProvider', () => {
  const originalFetch = globalThis.fetch;
  // `jest.spyOn(globalThis, 'fetch')` fails here — `fetch` is not an own property of the
  // Jest-node `globalThis`, only an inherited one, so `spyOn` can't patch it. Assigning
  // directly and restoring the original reference afterwards works regardless.
  let fetchMock: jest.Mock;
  let clock: VoyageClock & { sleepCalls: number[] };

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    clock = createVirtualClock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function buildProvider(
    voyageOverrides: Partial<typeof DEFAULT_VOYAGE_CONFIG> = {},
  ): VoyageEmbeddingProvider {
    return new VoyageEmbeddingProvider(
      getMockTypedConfig({ voyage: { ...DEFAULT_VOYAGE_CONFIG, ...voyageOverrides } }),
      clock,
    );
  }

  it('should throw VoyageApiKeyMissingError before any request when no key is configured', async () => {
    const provider = new VoyageEmbeddingProvider(getMockTypedConfig(), clock);

    await expect(
      provider.embed({ inputs: ['hello'], inputType: 'document' }),
    ).rejects.toBeInstanceOf(VoyageApiKeyMissingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should return an empty result without calling fetch for an empty input list', async () => {
    const provider = buildProvider();

    const result = await provider.embed({ inputs: [], inputType: 'document' });

    expect(result).toEqual({ embeddings: [], usage: { totalTokens: 0 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should set input_type to "document" for document embeds and "query" for query embeds', async () => {
    const provider = buildProvider();
    fetchMock.mockResolvedValue(buildResponse(['a']));

    await provider.embed({ inputs: ['a'], inputType: 'document' });
    await provider.embed({ inputs: ['a'], inputType: 'query' });

    const calls = fetchMock.mock.calls as [string, { body: string }][];
    const [documentCall, queryCall] = calls;
    const documentBody = JSON.parse(documentCall[1].body) as VoyageRequestBody;
    const queryBody = JSON.parse(queryCall[1].body) as VoyageRequestBody;
    expect(documentBody.input_type).toBe('document');
    expect(queryBody.input_type).toBe('query');
  });

  it('should batch at the 1000-input vendor limit', async () => {
    const provider = buildProvider();
    const inputs = Array.from({ length: 1001 }, (_, i) => `input-${i}`);
    fetchMock.mockImplementation((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as VoyageRequestBody;
      return Promise.resolve(buildResponse(body.input));
    });

    const result = await provider.embed({ inputs, inputType: 'document' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as [string, { body: string }][];
    const [firstCall, secondCall] = calls;
    const firstBody = JSON.parse(firstCall[1].body) as VoyageRequestBody;
    const secondBody = JSON.parse(secondCall[1].body) as VoyageRequestBody;
    expect(firstBody.input).toHaveLength(1000);
    expect(secondBody.input).toHaveLength(1);
    expect(result.embeddings).toHaveLength(1001);
  });

  it('should surface a non-2xx, non-429 response as VoyageRequestFailedError without retrying', async () => {
    const provider = buildProvider();
    fetchMock.mockResolvedValue(buildFailedResponse(500, 'internal error'));

    const error = await provider
      .embed({ inputs: ['a'], inputType: 'document' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoyageRequestFailedError);
    expect((error as VoyageRequestFailedError).status).toBe(500);
    expect((error as VoyageRequestFailedError).body).toBe('internal error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should fail immediately on a 401 without retrying — a bad key never succeeds on retry', async () => {
    const provider = buildProvider();
    fetchMock.mockResolvedValue(buildFailedResponse(401, 'invalid API key'));

    const error = await provider
      .embed({ inputs: ['a'], inputType: 'document' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoyageRequestFailedError);
    expect((error as VoyageRequestFailedError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleepCalls).toHaveLength(0);
  });

  it('should retry a 429 and return the eventual success', async () => {
    const provider = buildProvider();
    fetchMock
      .mockResolvedValueOnce(buildFailedResponse(429, 'rate limited'))
      .mockResolvedValueOnce(buildResponse(['a']));

    const result = await provider.embed({ inputs: ['a'], inputType: 'document' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.embeddings).toHaveLength(1);
    // One backoff sleep for the retry, on top of pacing sleeps — both come from the mocked clock.
    expect(clock.sleepCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('should honour a numeric Retry-After header instead of computed backoff', async () => {
    // pacing is not what this test is proving
    const provider = buildProvider({ requestsPerMinute: 1_000_000 });
    fetchMock
      .mockResolvedValueOnce(buildFailedResponse(429, 'rate limited', '5'))
      .mockResolvedValueOnce(buildResponse(['a']));

    await provider.embed({ inputs: ['a'], inputType: 'document' });

    expect(clock.sleepCalls).toContain(5000);
  });

  it('should throw VoyageRateLimitExceededError once the retry-attempt cap is hit', async () => {
    const provider = buildProvider({ maxRetries: 1, requestsPerMinute: 1_000_000 });
    fetchMock.mockResolvedValue(buildFailedResponse(429, 'still rate limited'));

    const error = await provider
      .embed({ inputs: ['a'], inputType: 'document' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoyageRateLimitExceededError);
    expect((error as VoyageRateLimitExceededError).attempts).toBe(1);
    // maxRetries=1: the initial attempt plus exactly one retry, then the cap fires.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should throw VoyageRateLimitExceededError once the total-wait budget is exhausted', async () => {
    const provider = buildProvider({
      maxRetries: 10,
      maxRetryWaitMs: 5_000,
      requestsPerMinute: 1_000_000,
    });
    // Every 429 asks for an 8s wait — the very first retry already exceeds the 5s wait budget,
    // so the cap fires before the attempt cap ever would.
    fetchMock.mockResolvedValue(buildFailedResponse(429, 'still rate limited', '8'));

    const error = await provider
      .embed({ inputs: ['a'], inputType: 'document' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VoyageRateLimitExceededError);
    expect((error as VoyageRateLimitExceededError).waitedMs).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should space consecutive requests to stay within the configured requests-per-minute pace', async () => {
    const provider = buildProvider({ requestsPerMinute: 3 });
    fetchMock.mockResolvedValue(buildResponse(['a']));

    await provider.embed({ inputs: ['a'], inputType: 'document' });
    await provider.embed({ inputs: ['a'], inputType: 'document' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 60000ms / 3 rpm = 20000ms between request slots.
    expect(clock.sleepCalls).toContain(20_000);
  });

  it('should report token usage summed across every batch', async () => {
    const provider = buildProvider();
    const inputs = Array.from({ length: 1001 }, (_, i) => `input-${i}`);
    fetchMock.mockImplementation((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as VoyageRequestBody;
      return Promise.resolve(buildResponse(body.input));
    });

    const result = await provider.embed({ inputs, inputType: 'document' });

    expect(result.usage.totalTokens).toBe(1000 * 2 + 1 * 2);
  });

  it('should resolve through Nest DI without an explicit clock provider', async () => {
    const module = await Test.createTestingModule({
      providers: [
        { provide: EMBEDDING_PROVIDER, useClass: VoyageEmbeddingProvider },
        { provide: TypedConfigService, useValue: getMockTypedConfig() },
      ],
    }).compile();

    const provider = module.get<VoyageEmbeddingProvider>(EMBEDDING_PROVIDER);

    await expect(provider.embed({ inputs: [], inputType: 'document' })).resolves.toEqual({
      embeddings: [],
      usage: { totalTokens: 0 },
    });

    await module.close();
  });
});
