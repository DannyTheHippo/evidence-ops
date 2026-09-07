import { OpenAiInvalidResponseError } from '../../../src/providers/model/errors/openai-invalid-response.error';
import { OpenAiRequestFailedError } from '../../../src/providers/model/errors/openai-request-failed.error';
import type { OpenAiClock } from '../../../src/providers/model/openai-chat-completions.client';
import { OpenAiCompatibleEmbeddingProvider } from '../../../src/providers/embedding/openai-compatible-embedding.provider';
import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

interface OpenAiCompatibleEmbeddingRequestBody {
  readonly model: string;
  readonly input: string[];
}

/** Full `openaiCompatible` namespace defaults for a configured provider — matches
 * `openai-compatible-model.provider.spec.ts`'s constant so both providers' specs stay symmetric. */
const DEFAULT_OPENAI_COMPATIBLE_CONFIG = {
  apiKey: undefined as string | undefined,
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3.1:8b',
  embeddingModel: 'mxbai-embed-large',
  timeoutMs: 30_000,
  structuredOutput: 'json_schema' as 'json_schema' | 'prompt',
  priceInputUsdPerMtok: 2,
  priceOutputUsdPerMtok: 6,
  embeddingPriceUsdPerMtok: 1,
};

const DIMENSIONS = 4;

function buildResponse(inputs: readonly string[]): Response {
  const body = {
    data: inputs.map((_, index) => ({
      embedding: Array.from({ length: DIMENSIONS }, () => index),
      index,
    })),
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

/** Instant, deterministic stand-in for `OpenAiClock` — `sleep` resolves immediately, recording
 * every requested delay so a test can assert backoff/Retry-After behaviour without ever waiting. */
function createVirtualClock(): OpenAiClock & { sleepCalls: number[] } {
  const sleepCalls: number[] = [];
  return {
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    },
    sleepCalls,
  };
}

describe('OpenAiCompatibleEmbeddingProvider', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  let clock: OpenAiClock & { sleepCalls: number[] };

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    clock = createVirtualClock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function buildProvider(
    overrides: Partial<typeof DEFAULT_OPENAI_COMPATIBLE_CONFIG> = {},
  ): OpenAiCompatibleEmbeddingProvider {
    return new OpenAiCompatibleEmbeddingProvider(
      getMockTypedConfig({
        openaiCompatible: { ...DEFAULT_OPENAI_COMPATIBLE_CONFIG, ...overrides },
        embedding: { provider: 'openai-compatible', dimensions: DIMENSIONS },
      }),
      clock,
    );
  }

  function lastRequestBody(): OpenAiCompatibleEmbeddingRequestBody {
    const calls = fetchMock.mock.calls as [string, { body: string }][];
    return JSON.parse(calls.at(-1)![1].body) as OpenAiCompatibleEmbeddingRequestBody;
  }

  it('should expose provider/model/dimensions info sourced from config', () => {
    const provider = buildProvider({ embeddingModel: 'nomic-embed-text' });

    expect(provider.info).toEqual({
      provider: 'openai-compatible',
      model: 'nomic-embed-text',
      dimensions: DIMENSIONS,
    });
  });

  it('should return an empty result without calling fetch for an empty input list', async () => {
    const provider = buildProvider();

    const result = await provider.embed({ inputs: [], inputType: 'document' });

    expect(result).toEqual({ embeddings: [], usage: { totalTokens: 0 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should POST model and input only — no dimensions, no input_type', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse(['hello']));
    const provider = buildProvider();

    await provider.embed({ inputs: ['hello'], inputType: 'document' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:11434/v1/embeddings');
    const body = lastRequestBody();
    expect(body).toEqual({ model: 'mxbai-embed-large', input: ['hello'] });
  });

  it('should send a Bearer Authorization header when an API key is configured', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse(['hello']));
    const provider = buildProvider({ apiKey: 'compatible-key' });

    await provider.embed({ inputs: ['hello'], inputType: 'document' });

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer compatible-key');
  });

  it('should omit the Authorization header entirely when no API key is configured', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse(['hello']));
    const provider = buildProvider({ apiKey: undefined });

    await provider.embed({ inputs: ['hello'], inputType: 'document' });

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('should return embeddings sorted by index regardless of response order', async () => {
    const provider = buildProvider();
    const body = {
      data: [
        { embedding: [1, 1, 1, 1], index: 1 },
        { embedding: [0, 0, 0, 0], index: 0 },
      ],
      usage: { total_tokens: 4 },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });

    const result = await provider.embed({ inputs: ['a', 'b'], inputType: 'document' });

    expect(result.embeddings).toEqual([
      [0, 0, 0, 0],
      [1, 1, 1, 1],
    ]);
  });

  it('should throw OpenAiInvalidResponseError naming both dimension counts when a returned vector width mismatches', async () => {
    const provider = buildProvider();
    const body = {
      data: [{ embedding: [0, 0, 0], index: 0 }],
      usage: { total_tokens: 2 },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });

    const error = await provider
      .embed({ inputs: ['hello'], inputType: 'document' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAiInvalidResponseError);
    expect((error as OpenAiInvalidResponseError).message).toContain(String(DIMENSIONS));
    expect((error as OpenAiInvalidResponseError).message).toContain('3');
  });

  it('should batch at 2,048 inputs per request', async () => {
    const provider = buildProvider();
    const inputs = Array.from({ length: 2_049 }, (_, i) => `input-${i}`);
    fetchMock.mockImplementation((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as OpenAiCompatibleEmbeddingRequestBody;
      return Promise.resolve(buildResponse(body.input));
    });

    const result = await provider.embed({ inputs, inputType: 'document' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as [string, { body: string }][];
    const [firstCall, secondCall] = calls;
    const firstBody = JSON.parse(firstCall[1].body) as OpenAiCompatibleEmbeddingRequestBody;
    const secondBody = JSON.parse(secondCall[1].body) as OpenAiCompatibleEmbeddingRequestBody;
    expect(firstBody.input).toHaveLength(2_048);
    expect(secondBody.input).toHaveLength(1);
    expect(result.embeddings).toHaveLength(2_049);
  });

  it('should fail immediately on a non-retryable 4xx without retrying', async () => {
    fetchMock.mockResolvedValue(buildFailedResponse(400, 'bad request'));
    const provider = buildProvider();

    const error = await provider
      .embed({ inputs: ['hello'], inputType: 'document' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAiRequestFailedError);
    expect((error as OpenAiRequestFailedError).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleepCalls).toHaveLength(0);
  });

  it('should retry a 429 and honour a numeric Retry-After header instead of the computed backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(buildFailedResponse(429, 'rate limited', '5'))
      .mockResolvedValueOnce(buildResponse(['hello']));
    const provider = buildProvider();

    const result = await provider.embed({ inputs: ['hello'], inputType: 'document' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.embeddings).toHaveLength(1);
    expect(clock.sleepCalls).toEqual([5000]);
  });
});
