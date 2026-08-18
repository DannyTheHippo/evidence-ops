import { z } from 'zod/v4';
import { ModelBudgetExceededError } from '../../../src/providers/model/errors/model-budget-exceeded.error';
import { ModelSchemaValidationError } from '../../../src/providers/model/errors/model-schema-validation.error';
import { OpenAiInvalidResponseError } from '../../../src/providers/model/errors/openai-invalid-response.error';
import { OpenAiRequestFailedError } from '../../../src/providers/model/errors/openai-request-failed.error';
import { UnknownModelPricingError } from '../../../src/providers/model/errors/unknown-model-pricing.error';
import type { ModelRequest } from '../../../src/providers/model/model-provider.interface';
import { computeOpenAiCostUsd } from '../../../src/providers/model/openai-pricing.table';
import {
  OpenAiModelProvider,
  type OpenAiClock,
} from '../../../src/providers/model/openai-model.provider';
import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

interface OpenAiRequestBody {
  readonly model: string;
  readonly messages: { role: string; content: string }[];
  readonly max_completion_tokens: number;
  readonly response_format?: { type: string; json_schema: { name: string; schema: unknown } };
}

/** Full `openai` namespace defaults for a configured provider; the default mock model (`gpt-5.1`)
 * has no pricing entry, so tests override to `gpt-5`, which does. */
const DEFAULT_OPENAI_CONFIG = {
  apiKey: 'openai-key',
  model: 'gpt-5',
  baseUrl: 'https://api.openai.com/v1',
  timeoutMs: 30_000,
};

interface OpenAiUsageOverrides {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly prompt_tokens_details?: { cached_tokens: number };
}

function buildResponse(
  content: string,
  usage: OpenAiUsageOverrides = {},
  finishReason?: string,
): Response {
  const body = {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, ...usage },
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

/** A 2xx response whose body does not match the expected chat/completions envelope shape. */
function buildMalformedResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve({ choices: [] }),
    text: () => Promise.resolve('malformed'),
  } as unknown as Response;
}

/** What `AbortSignal.timeout(...)` rejects `fetch` with when the timeout fires first. */
function buildTimeoutError(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
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

describe('OpenAiModelProvider', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  let clock: OpenAiClock & { sleepCalls: number[] };

  const baseRequest: ModelRequest<undefined> = {
    taskClass: 'qa_answer',
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
    maxTokens: 100,
    maxCostUsd: 1,
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    clock = createVirtualClock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function buildProvider(
    openaiOverrides: Partial<typeof DEFAULT_OPENAI_CONFIG> = {},
  ): OpenAiModelProvider {
    return new OpenAiModelProvider(
      getMockTypedConfig({ openai: { ...DEFAULT_OPENAI_CONFIG, ...openaiOverrides } }),
      clock,
    );
  }

  function lastRequestBody(): OpenAiRequestBody {
    const calls = fetchMock.mock.calls as [string, { body: string }][];
    return JSON.parse(calls.at(-1)![1].body) as OpenAiRequestBody;
  }

  it('should expose provider/model info sourced from config', () => {
    const provider = buildProvider({ model: 'gpt-5.1-mini' });

    expect(provider.info).toEqual({ provider: 'openai', model: 'gpt-5.1-mini' });
  });

  it('should refuse the call before issuing any request for a model with no pricing entry', async () => {
    const provider = buildProvider({ model: 'gpt-nonexistent' });

    await expect(provider.generate(baseRequest)).rejects.toBeInstanceOf(UnknownModelPricingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should refuse the call before issuing any request when the worst-case estimate exceeds maxCostUsd', async () => {
    const provider = buildProvider();

    await expect(provider.generate({ ...baseRequest, maxCostUsd: 0 })).rejects.toBeInstanceOf(
      ModelBudgetExceededError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should return the text output on a schema-less request without retrying', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider();

    const result = await provider.generate(baseRequest);

    expect(result.output).toBe('Paris');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should send max_completion_tokens, not the deprecated max_tokens', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider();

    await provider.generate({ ...baseRequest, maxTokens: 256 });

    const body = lastRequestBody();
    expect(body.max_completion_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('should send a Bearer Authorization header when an API key is configured', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider({ apiKey: 'openai-key' });

    await provider.generate(baseRequest);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer openai-key');
  });

  it('should omit the Authorization header entirely when no API key is configured, not send "Bearer undefined"', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider({ apiKey: undefined });

    await provider.generate(baseRequest);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('should prepend request.system as a leading system-role message', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider();

    await provider.generate({ ...baseRequest, system: 'You are a helpful assistant.' });

    const body = lastRequestBody();
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
  });

  it('should never forward passOrdinal or tenantId to the wire — they are cache/spend fields only', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider();

    await provider.generate({ ...baseRequest, passOrdinal: 2, tenantId: 'tenant-a' });

    const body = lastRequestBody();
    expect(body).not.toHaveProperty('passOrdinal');
    expect(body).not.toHaveProperty('tenantId');
  });

  it('should price costUsd from the pricing table using actual usage', async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse('Paris', { prompt_tokens: 100, completion_tokens: 20 }),
    );
    const provider = buildProvider();

    const result = await provider.generate(baseRequest);

    const expectedCost = computeOpenAiCostUsd('gpt-5', {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
    });
    expect(result.costUsd).toBeCloseTo(expectedCost, 10);
  });

  it('should price the cached portion of input tokens using prompt_tokens_details.cached_tokens when present', async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse('Paris', {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    );
    const provider = buildProvider();

    const result = await provider.generate(baseRequest);

    const expectedCost = computeOpenAiCostUsd('gpt-5', {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
    });
    expect(result.costUsd).toBeCloseTo(expectedCost, 10);
    expect(result.usage.cacheReadInputTokens).toBe(40);
  });

  it('should default cache tokens to zero when prompt_tokens_details is absent — the self-hosted vLLM/Ollama shape', async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse('Paris', { prompt_tokens: 10, completion_tokens: 5 }),
    );
    const provider = buildProvider();

    const result = await provider.generate(baseRequest);

    expect(result.usage.cacheReadInputTokens).toBe(0);
    expect(result.usage.cacheCreationInputTokens).toBe(0);
  });

  describe('schema-validation retry', () => {
    const schema = z.object({ answer: z.string() });
    const requestWithSchema: ModelRequest<typeof schema> = { ...baseRequest, outputSchema: schema };

    it('should retry exactly once and succeed when the retry output validates', async () => {
      fetchMock
        .mockResolvedValueOnce(
          buildResponse('not json', { prompt_tokens: 10, completion_tokens: 5 }),
        )
        .mockResolvedValueOnce(
          buildResponse('{"answer":"Paris"}', { prompt_tokens: 20, completion_tokens: 8 }),
        );
      const provider = buildProvider();

      const result = await provider.generate(requestWithSchema);

      expect(result.output).toEqual({ answer: 'Paris' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.usage.inputTokens).toBe(30);
      expect(result.usage.outputTokens).toBe(13);
    });

    it('should feed the validation issues from the first attempt back to the model on retry', async () => {
      fetchMock
        .mockResolvedValueOnce(buildResponse('not json'))
        .mockResolvedValueOnce(buildResponse('{"answer":"Paris"}'));
      const provider = buildProvider();

      await provider.generate(requestWithSchema);

      const retryBody = lastRequestBody();
      const retryMessage = retryBody.messages.at(-1);
      expect(retryMessage?.role).toBe('user');
      expect(retryMessage?.content).toContain('failed schema validation');
    });

    it('should throw ModelSchemaValidationError after exactly one retry, never stacking further retries', async () => {
      fetchMock
        .mockResolvedValueOnce(buildResponse('not json'))
        .mockResolvedValueOnce(buildResponse('still not json'));
      const provider = buildProvider();

      await expect(provider.generate(requestWithSchema)).rejects.toBeInstanceOf(
        ModelSchemaValidationError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('wrapped (union-rooted) schema unwrapping', () => {
    const unionSchema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('answered'), value: z.string() }),
      z.object({ kind: z.literal('abstained'), reason: z.string() }),
    ]);
    const requestWithSchema: ModelRequest<typeof unionSchema> = {
      ...baseRequest,
      outputSchema: unionSchema,
    };

    it('should send the schema wrapped under a "result" property, named from taskClass', async () => {
      fetchMock.mockResolvedValueOnce(
        buildResponse('{"result":{"kind":"abstained","reason":"n/a"}}'),
      );
      const provider = buildProvider();

      await provider.generate(requestWithSchema);

      const body = lastRequestBody();
      expect(body.response_format?.json_schema.name).toBe('qa_answer');
      const schema = body.response_format?.json_schema.schema as {
        properties: Record<string, unknown>;
      };
      expect(Object.keys(schema.properties)).toEqual(['result']);
    });

    it('should transparently unwrap the { result } envelope for the caller', async () => {
      fetchMock.mockResolvedValueOnce(
        buildResponse('{"result":{"kind":"abstained","reason":"n/a"}}'),
      );
      const provider = buildProvider();

      const result = await provider.generate(requestWithSchema);

      expect(result.output).toEqual({ kind: 'abstained', reason: 'n/a' });
    });

    it('should retry on a wrapped-schema mismatch and unwrap the corrected retry response', async () => {
      fetchMock
        .mockResolvedValueOnce(buildResponse('not json'))
        .mockResolvedValueOnce(buildResponse('{"result":{"kind":"answered","value":"Paris"}}'));
      const provider = buildProvider();

      const result = await provider.generate(requestWithSchema);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.output).toEqual({ kind: 'answered', value: 'Paris' });
    });
  });

  it('should throw OpenAiInvalidResponseError when a 2xx response does not match the expected envelope', async () => {
    fetchMock.mockResolvedValueOnce(buildMalformedResponse());
    const provider = buildProvider();

    await expect(provider.generate(baseRequest)).rejects.toBeInstanceOf(OpenAiInvalidResponseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should pass a timeout signal built from the configured timeoutMs', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider({ timeoutMs: 5_000 });

    await provider.generate(baseRequest);

    const [, init] = fetchMock.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('should fail immediately on a 400 without retrying — a bad request never succeeds on retry', async () => {
    fetchMock.mockResolvedValue(buildFailedResponse(400, 'bad request'));
    const provider = buildProvider();

    const error = await provider.generate(baseRequest).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAiRequestFailedError);
    expect((error as OpenAiRequestFailedError).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleepCalls).toHaveLength(0);
  });

  it('should fail immediately on a 401 without retrying — a bad key never succeeds on retry', async () => {
    fetchMock.mockResolvedValue(buildFailedResponse(401, 'invalid API key'));
    const provider = buildProvider();

    const error = await provider.generate(baseRequest).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAiRequestFailedError);
    expect((error as OpenAiRequestFailedError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should retry a 429 and return the eventual success', async () => {
    fetchMock
      .mockResolvedValueOnce(buildFailedResponse(429, 'rate limited'))
      .mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider();

    const result = await provider.generate(baseRequest);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.output).toBe('Paris');
    expect(clock.sleepCalls).toHaveLength(1);
  });

  it('should honour a numeric Retry-After header instead of the computed backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(buildFailedResponse(429, 'rate limited', '5'))
      .mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider();

    await provider.generate(baseRequest);

    expect(clock.sleepCalls).toEqual([5000]);
  });

  it('should retry a 5xx and return the eventual success', async () => {
    fetchMock
      .mockResolvedValueOnce(buildFailedResponse(503, 'service unavailable'))
      .mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider();

    const result = await provider.generate(baseRequest);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.output).toBe('Paris');
  });

  it('should retry a request-timeout abort and return the eventual success', async () => {
    fetchMock
      .mockRejectedValueOnce(buildTimeoutError())
      .mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider();

    const result = await provider.generate(baseRequest);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.output).toBe('Paris');
  });

  it('should retry a network error (fetch rejecting with no response) and return the eventual success', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider();

    const result = await provider.generate(baseRequest);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.output).toBe('Paris');
  });

  it('should throw OpenAiRequestFailedError once the transport-retry budget is exhausted', async () => {
    fetchMock.mockResolvedValue(buildFailedResponse(503, 'still down'));
    const provider = buildProvider();

    const error = await provider.generate(baseRequest).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAiRequestFailedError);
    expect((error as OpenAiRequestFailedError).status).toBe(503);
    // Initial attempt plus the two transport retries this provider allows, mirroring the
    // Anthropic SDK's own default retry count.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
