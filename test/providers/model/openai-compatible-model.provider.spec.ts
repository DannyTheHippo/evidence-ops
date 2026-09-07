import { z } from 'zod/v4';
import { ModelOutputTruncatedError } from '../../../src/providers/model/errors/model-output-truncated.error';
import { ModelSchemaValidationError } from '../../../src/providers/model/errors/model-schema-validation.error';
import { OpenAiRequestFailedError } from '../../../src/providers/model/errors/openai-request-failed.error';
import type { ModelRequest } from '../../../src/providers/model/model-provider.interface';
import type { OpenAiClock } from '../../../src/providers/model/openai-chat-completions.client';
import { OpenAiCompatibleModelProvider } from '../../../src/providers/model/openai-compatible-model.provider';
import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

interface OpenAiCompatibleRequestBody {
  readonly model: string;
  readonly messages: { role: string; content: string }[];
  readonly max_completion_tokens: number;
  readonly response_format?: {
    type: string;
    json_schema: { name: string; strict: boolean; schema: unknown };
  };
}

/** Full `openaiCompatible` namespace defaults for a configured provider — prices are `undefined`
 * on the shared mock (matching the real config's "never defaulted" rule), so every test here
 * that constructs a provider supplies them explicitly. */
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

function buildResponse(
  content: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } = {},
  finishReason?: string | null,
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

describe('OpenAiCompatibleModelProvider', () => {
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
    overrides: Partial<typeof DEFAULT_OPENAI_COMPATIBLE_CONFIG> = {},
  ): OpenAiCompatibleModelProvider {
    return new OpenAiCompatibleModelProvider(
      getMockTypedConfig({
        openaiCompatible: { ...DEFAULT_OPENAI_COMPATIBLE_CONFIG, ...overrides },
      }),
      clock,
    );
  }

  function lastRequestBody(): OpenAiCompatibleRequestBody {
    const calls = fetchMock.mock.calls as [string, { body: string }][];
    return JSON.parse(calls.at(-1)![1].body) as OpenAiCompatibleRequestBody;
  }

  it('should expose provider/model info sourced from config', () => {
    const provider = buildProvider({ model: 'mixtral-8x7b' });

    expect(provider.info).toEqual({ provider: 'openai-compatible', model: 'mixtral-8x7b' });
  });

  // Nest registers this class as an ordinary provider, so it is constructed on every boot no matter
  // which base `MODEL_PROVIDER` selects. Refusing an unset price here would take down the default
  // `anthropic` deployment, which never calls this class — the refusal belongs to the two places
  // that know the provider is actually in use, asserted below and in `providers.module.spec.ts`.
  it('should construct without configured prices, so an unselected provider cannot break boot', () => {
    expect(
      () =>
        new OpenAiCompatibleModelProvider(
          getMockTypedConfig({
            openaiCompatible: {
              ...DEFAULT_OPENAI_COMPATIBLE_CONFIG,
              priceInputUsdPerMtok: undefined,
              priceOutputUsdPerMtok: undefined,
            },
          }),
        ),
    ).not.toThrow();
  });

  it.each([
    ['priceInputUsdPerMtok', 'OPENAI_COMPATIBLE_PRICE_INPUT_USD_PER_MTOK'],
    ['priceOutputUsdPerMtok', 'OPENAI_COMPATIBLE_PRICE_OUTPUT_USD_PER_MTOK'],
  ])(
    'should refuse to price a request when %s is not configured, rather than charging $0',
    async (field, envVar) => {
      fetchMock.mockResolvedValueOnce(buildResponse('Paris'));
      const provider = new OpenAiCompatibleModelProvider(
        getMockTypedConfig({
          openaiCompatible: { ...DEFAULT_OPENAI_COMPATIBLE_CONFIG, [field]: undefined },
        }),
      );

      await expect(provider.generate(baseRequest)).rejects.toThrow(envVar);
    },
  );

  it('should send a Bearer Authorization header when an API key is configured', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider({ apiKey: 'compatible-key' });

    await provider.generate(baseRequest);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer compatible-key');
  });

  it('should omit the Authorization header entirely when no API key is configured', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider({ apiKey: undefined });

    await provider.generate(baseRequest);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('should never forward passOrdinal or tenantId to the wire — they are cache/spend fields only', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider();

    await provider.generate({ ...baseRequest, passOrdinal: 2, tenantId: 'tenant-a' });

    const body = lastRequestBody();
    expect(body).not.toHaveProperty('passOrdinal');
    expect(body).not.toHaveProperty('tenantId');
  });

  it('should price costUsd from the configured per-token rates using actual usage', async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse('Paris', { prompt_tokens: 100, completion_tokens: 20 }),
    );
    const provider = buildProvider({ priceInputUsdPerMtok: 2, priceOutputUsdPerMtok: 6 });

    const result = await provider.generate(baseRequest);

    expect(result.costUsd).toBeCloseTo((100 * 2 + 20 * 6) / 1_000_000, 10);
  });

  it('should never refuse the budget check and price the call at $0 when both prices are configured as zero', async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse('Paris', { prompt_tokens: 1000, completion_tokens: 1000 }),
    );
    const provider = buildProvider({ priceInputUsdPerMtok: 0, priceOutputUsdPerMtok: 0 });

    const result = await provider.generate({ ...baseRequest, maxCostUsd: 0 });

    expect(result.costUsd).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should refuse the call before issuing any request when the worst-case estimate exceeds maxCostUsd', async () => {
    const provider = buildProvider({ priceInputUsdPerMtok: 2, priceOutputUsdPerMtok: 6 });

    await expect(provider.generate({ ...baseRequest, maxCostUsd: 0 })).rejects.toThrow(
      /budget cap/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('structuredOutput: json_schema', () => {
    const schema = z.object({ answer: z.string() });
    const requestWithSchema: ModelRequest<typeof schema> = { ...baseRequest, outputSchema: schema };

    it('should send response_format with strict:true, named from taskClass', async () => {
      fetchMock.mockResolvedValueOnce(buildResponse('{"answer":"Paris"}'));
      const provider = buildProvider({ structuredOutput: 'json_schema' });

      await provider.generate(requestWithSchema);

      const body = lastRequestBody();
      expect(body.response_format?.type).toBe('json_schema');
      expect(body.response_format?.json_schema.strict).toBe(true);
      expect(body.response_format?.json_schema.name).toBe('qa_answer');
    });
  });

  describe('structuredOutput: prompt', () => {
    const schema = z.object({ answer: z.string() });
    const requestWithSchema: ModelRequest<typeof schema> = {
      ...baseRequest,
      outputSchema: schema,
      system: 'You are a helpful assistant.',
    };

    it('should omit response_format and append the schema to the end of the system message', async () => {
      fetchMock.mockResolvedValueOnce(buildResponse('{"answer":"Paris"}'));
      const provider = buildProvider({ structuredOutput: 'prompt' });

      await provider.generate(requestWithSchema);

      const body = lastRequestBody();
      expect(body.response_format).toBeUndefined();
      const systemMessage = body.messages[0];
      expect(systemMessage.role).toBe('system');
      expect(systemMessage.content.startsWith('You are a helpful assistant.')).toBe(true);
      expect(systemMessage.content).toContain('JSON Schema');
      expect(systemMessage.content.trim().endsWith('}')).toBe(true);
    });

    it('should validate the model output against the unwrapped schema', async () => {
      fetchMock.mockResolvedValueOnce(buildResponse('{"answer":"Paris"}'));
      const provider = buildProvider({ structuredOutput: 'prompt' });

      const result = await provider.generate(requestWithSchema);

      expect(result.output).toEqual({ answer: 'Paris' });
    });
  });

  describe('schema-validation retry', () => {
    const schema = z.object({ answer: z.string() });
    const requestWithSchema: ModelRequest<typeof schema> = { ...baseRequest, outputSchema: schema };

    it('should retry exactly once and succeed when the retry output validates', async () => {
      fetchMock
        .mockResolvedValueOnce(buildResponse('not json', {}, 'stop'))
        .mockResolvedValueOnce(buildResponse('{"answer":"Paris"}', {}, 'stop'));
      const provider = buildProvider();

      const result = await provider.generate(requestWithSchema);

      expect(result.output).toEqual({ answer: 'Paris' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
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

  describe('output-cap truncation', () => {
    const schema = z.object({ answer: z.string() });
    const requestWithSchema: ModelRequest<typeof schema> = { ...baseRequest, outputSchema: schema };

    it('should throw ModelOutputTruncatedError on a first response with finish_reason "length"', async () => {
      fetchMock.mockResolvedValueOnce(
        buildResponse('{"answ', { completion_tokens: 100 }, 'length'),
      );
      const provider = buildProvider();

      const error = await provider.generate(requestWithSchema).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ModelOutputTruncatedError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('should fail immediately on a non-retryable 4xx without retrying', async () => {
    fetchMock.mockResolvedValue(buildFailedResponse(400, 'bad request'));
    const provider = buildProvider();

    const error = await provider.generate(baseRequest).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenAiRequestFailedError);
    expect((error as OpenAiRequestFailedError).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleepCalls).toHaveLength(0);
  });

  it('should retry a 429 and honour a numeric Retry-After header instead of the computed backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(buildFailedResponse(429, 'rate limited', '5'))
      .mockResolvedValueOnce(buildResponse('Paris'));
    const provider = buildProvider();

    const result = await provider.generate(baseRequest);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.output).toBe('Paris');
    expect(clock.sleepCalls).toEqual([5000]);
  });
});
