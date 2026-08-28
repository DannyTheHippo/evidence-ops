import { z } from 'zod/v4';
import { validateEnvironment } from '../../../src/config/environment/environment.config';
import { computeAnthropicCostUsd } from '../../../src/providers/model/anthropic-pricing.table';
import { ModelBudgetExceededError } from '../../../src/providers/model/errors/model-budget-exceeded.error';
import { ModelOutputTruncatedError } from '../../../src/providers/model/errors/model-output-truncated.error';
import { ModelSchemaValidationError } from '../../../src/providers/model/errors/model-schema-validation.error';
import { UnknownModelPricingError } from '../../../src/providers/model/errors/unknown-model-pricing.error';
import type { ModelRequest } from '../../../src/providers/model/model-provider.interface';
import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

// The real SDK client is never constructed against the network — `messages.create` is the only
// method the provider calls, so only that surface needs a mock. Mocking the module root (not
// `Anthropic.prototype`) is required because `AnthropicModelProvider` builds its own client
// internally with no way to inject one.
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn(),
}));

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicModelProvider } from '../../../src/providers/model/anthropic-model.provider';

const MockAnthropic = Anthropic as unknown as jest.Mock;

function buildUsage(overrides: Partial<Anthropic.Usage> = {}): Anthropic.Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    input_tokens: 10,
    output_tokens: 5,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    ...overrides,
  };
}

function buildMessage(
  text: string,
  usage: Partial<Anthropic.Usage> = {},
  stopReason: Anthropic.StopReason = 'end_turn',
): Anthropic.Message {
  return {
    id: 'msg_test',
    container: null,
    content: [{ type: 'text', text, citations: null }],
    model: 'claude-sonnet-5',
    role: 'assistant',
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    type: 'message',
    usage: buildUsage(usage),
  };
}

describe('AnthropicModelProvider', () => {
  let mockCreate: jest.Mock<Promise<Anthropic.Message>, [unknown]>;

  const baseRequest: ModelRequest<undefined> = {
    taskClass: 'qa_answer',
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
    maxTokens: 100,
    maxCostUsd: 1,
  };

  beforeEach(() => {
    mockCreate = jest.fn<Promise<Anthropic.Message>, [unknown]>();
    MockAnthropic.mockImplementation(() => ({ messages: { create: mockCreate } }));
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should construct the SDK client with the configured request timeout', () => {
    new AnthropicModelProvider(getMockTypedConfig());

    expect(MockAnthropic).toHaveBeenCalledWith(expect.objectContaining({ timeout: 60000 }));
  });

  it('should read the SDK client timeout from config rather than a hardcoded constant', () => {
    const config = getMockTypedConfig({
      anthropic: {
        apiKey: undefined,
        model: 'claude-sonnet-5',
        timeoutMs: 15000,
        factExtractionModel: undefined,
      },
    });

    new AnthropicModelProvider(config);

    expect(MockAnthropic).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15000 }));
  });

  it('should refuse the call before issuing any request when the worst-case estimate exceeds maxCostUsd', async () => {
    const provider = new AnthropicModelProvider(getMockTypedConfig());

    await expect(provider.generate({ ...baseRequest, maxCostUsd: 0 })).rejects.toBeInstanceOf(
      ModelBudgetExceededError,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should refuse the call before issuing any request for a model with no pricing entry', async () => {
    const config = getMockTypedConfig({
      anthropic: {
        apiKey: undefined,
        model: 'claude-unpriced',
        timeoutMs: 60000,
        factExtractionModel: undefined,
      },
    });
    const provider = new AnthropicModelProvider(config);

    await expect(provider.generate(baseRequest)).rejects.toBeInstanceOf(UnknownModelPricingError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should return the text output on a schema-less request without retrying', async () => {
    mockCreate.mockResolvedValueOnce(buildMessage('Paris'));
    const provider = new AnthropicModelProvider(getMockTypedConfig());

    const result = await provider.generate(baseRequest);

    expect(result.output).toBe('Paris');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('should not send a temperature param, for either task class — this model tier rejects it with a 400', async () => {
    // Regression test: a live call once returned `400 invalid_request_error: \`temperature\` is
    // deprecated for this model`. Every request built by this provider must omit the key
    // entirely, not just leave it undefined.
    mockCreate
      .mockResolvedValueOnce(buildMessage('Paris'))
      .mockResolvedValueOnce(buildMessage('extracted'));
    const provider = new AnthropicModelProvider(getMockTypedConfig());

    await provider.generate({ ...baseRequest, taskClass: 'qa_answer' });
    await provider.generate({ ...baseRequest, taskClass: 'fact_extraction' });

    const [qaCall, factCall] = mockCreate.mock.calls.map((call) => call[0]);
    expect(qaCall).not.toHaveProperty('temperature');
    expect(factCall).not.toHaveProperty('temperature');
  });

  it('should never forward passOrdinal to the SDK — it is a cache-partitioning field only', async () => {
    mockCreate.mockResolvedValueOnce(buildMessage('Paris'));
    const provider = new AnthropicModelProvider(getMockTypedConfig());

    await provider.generate({ ...baseRequest, passOrdinal: 2 });

    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('passOrdinal');
  });

  it('should price costUsd from the pricing table including cache-write and cache-read multipliers', async () => {
    mockCreate.mockResolvedValueOnce(
      buildMessage('Paris', {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 },
        cache_read_input_tokens: 20,
      }),
    );
    const provider = new AnthropicModelProvider(getMockTypedConfig());

    const result = await provider.generate(baseRequest);

    const expectedCost = computeAnthropicCostUsd('claude-sonnet-5', {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreation5mInputTokens: 100,
      cacheCreation1hInputTokens: 50,
      cacheReadInputTokens: 20,
    });
    expect(result.costUsd).toBeCloseTo(expectedCost, 10);
  });

  describe('schema-validation retry', () => {
    const schema = z.object({ answer: z.string() });
    const requestWithSchema: ModelRequest<typeof schema> = { ...baseRequest, outputSchema: schema };

    it('should retry exactly once and succeed when the retry output validates, for a schema failure that is not a truncation', async () => {
      mockCreate
        .mockResolvedValueOnce(
          buildMessage('not json', { input_tokens: 10, output_tokens: 5 }, 'end_turn'),
        )
        .mockResolvedValueOnce(
          buildMessage('{"answer":"Paris"}', { input_tokens: 20, output_tokens: 8 }, 'end_turn'),
        );
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      const result = await provider.generate(requestWithSchema);

      expect(result.output).toEqual({ answer: 'Paris' });
      expect(mockCreate).toHaveBeenCalledTimes(2);
      // usage/cost accumulate across both billed calls, not just the winning one
      expect(result.usage.inputTokens).toBe(30);
      expect(result.usage.outputTokens).toBe(13);
    });

    it('should throw ModelSchemaValidationError after exactly one retry, never stacking further retries', async () => {
      mockCreate
        .mockResolvedValueOnce(buildMessage('not json'))
        .mockResolvedValueOnce(buildMessage('still not json'));
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      await expect(provider.generate(requestWithSchema)).rejects.toBeInstanceOf(
        ModelSchemaValidationError,
      );
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('should feed the validation issues from the first attempt back to the model on retry', async () => {
      mockCreate
        .mockResolvedValueOnce(buildMessage('not json'))
        .mockResolvedValueOnce(buildMessage('{"answer":"Paris"}'));
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      await provider.generate(requestWithSchema);

      const retryCall = mockCreate.mock.calls[1][0] as {
        messages: { role: string; content: string }[];
      };
      const retryMessage = retryCall.messages.at(-1);
      expect(retryMessage?.role).toBe('user');
      expect(retryMessage?.content).toContain('failed schema validation');
    });

    it('should not send a temperature param on the retry call either', async () => {
      mockCreate
        .mockResolvedValueOnce(buildMessage('not json'))
        .mockResolvedValueOnce(buildMessage('{"answer":"Paris"}'));
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      await provider.generate(requestWithSchema);

      const [firstCall, retryCall] = mockCreate.mock.calls.map((call) => call[0]);
      expect(firstCall).not.toHaveProperty('temperature');
      expect(retryCall).not.toHaveProperty('temperature');
    });

    it('should send a structured-output schema with no $defs/$ref for a discriminated union that reuses a branch-nested schema', async () => {
      // Regression test for a live 400: `@anthropic-ai/sdk`'s `zodOutputFormat()` hardcodes
      // `reused: 'ref'`, which hoists a schema like `answerContractSchema` (a discriminated union
      // reusing an array-element schema inside one branch) into `$defs`/`$ref` — Anthropic's
      // structured-outputs API rejects `$defs` under `anyOf`. See `structured-output-format.util.ts`.
      const item = z.object({ value: z.string() });
      const unionSchema = z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), items: z.array(item) }),
        z.object({ kind: z.literal('b'), reason: z.string() }),
      ]);
      mockCreate.mockResolvedValueOnce(buildMessage('{"kind":"b","reason":"no data"}'));
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      await provider.generate({ ...baseRequest, outputSchema: unionSchema });

      const call = mockCreate.mock.calls[0][0] as {
        output_config: { format: { schema: Record<string, unknown> } };
      };
      const serializedSchema = JSON.stringify(call.output_config.format.schema);
      expect(serializedSchema).not.toContain('$defs');
      expect(serializedSchema).not.toContain('$ref');
    });
  });

  describe('output-cap truncation', () => {
    const schema = z.object({ answer: z.string() });
    const requestWithSchema: ModelRequest<typeof schema> = { ...baseRequest, outputSchema: schema };

    it('should throw ModelOutputTruncatedError on a first response that hit max_tokens, without making a second (doomed) call', async () => {
      mockCreate.mockResolvedValueOnce(
        buildMessage('{"answ', { output_tokens: 100 }, 'max_tokens'),
      );
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      const error = await provider.generate(requestWithSchema).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ModelOutputTruncatedError);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('should throw ModelOutputTruncatedError on a retry response that also hit max_tokens', async () => {
      mockCreate
        .mockResolvedValueOnce(buildMessage('not json', { output_tokens: 5 }, 'end_turn'))
        .mockResolvedValueOnce(buildMessage('{"answ', { output_tokens: 100 }, 'max_tokens'));
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      const error = await provider.generate(requestWithSchema).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ModelOutputTruncatedError);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('should throw ModelOutputTruncatedError on an unparseable response that stopped for exceeding the context window, advising to reduce the prompt rather than raise maxTokens', async () => {
      mockCreate.mockResolvedValueOnce(
        buildMessage('{"answ', { output_tokens: 100 }, 'model_context_window_exceeded'),
      );
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      const error = (await provider
        .generate(requestWithSchema)
        .catch((e: unknown) => e)) as ModelOutputTruncatedError;

      expect(error).toBeInstanceOf(ModelOutputTruncatedError);
      expect(error.stopReason).toBe('model_context_window_exceeded');
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(error.message).not.toContain('Raise maxTokens');
      expect(error.message).toContain('Reduce the prompt');
    });

    it('should return a response that parses and validates even though it hit max_tokens — a valid response is valid regardless of why generation stopped', async () => {
      mockCreate.mockResolvedValueOnce(
        buildMessage('{"answer":"Paris"}', { output_tokens: 100 }, 'max_tokens'),
      );
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      const result = await provider.generate(requestWithSchema);

      expect(result.output).toEqual({ answer: 'Paris' });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('should carry the stop reason, maxTokens cap, output token count and raw text as public fields, and state the cap, count and stop reason in the message without embedding the raw output', async () => {
      mockCreate.mockResolvedValueOnce(buildMessage('{"answ', { output_tokens: 77 }, 'max_tokens'));
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      const error = (await provider
        .generate({ ...requestWithSchema, maxTokens: 100 })
        .catch((e: unknown) => e)) as ModelOutputTruncatedError;

      expect(error.stopReason).toBe('max_tokens');
      expect(error.maxTokens).toBe(100);
      expect(error.outputTokens).toBe(77);
      expect(error.raw).toBe('{"answ');
      expect(error.message).toContain('100');
      expect(error.message).toContain('77');
      expect(error.message).toContain('max_tokens');
      expect(error.message).not.toMatch(/JSON|schema/i);
      expect(error.message).not.toContain('{"answ');
    });

    it("should not throw on a truncated response for the schema-less branch — a truncated free-text answer is the caller's business", async () => {
      mockCreate.mockResolvedValueOnce(buildMessage('Par', {}, 'max_tokens'));
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      const result = await provider.generate(baseRequest);

      expect(result.output).toBe('Par');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('should not append an empty assistant turn on retry when the first attempt produced no text', async () => {
      mockCreate
        .mockResolvedValueOnce(buildMessage('', {}, 'end_turn'))
        .mockResolvedValueOnce(buildMessage('{"answer":"Paris"}', {}, 'end_turn'));
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      await provider.generate(requestWithSchema);

      const retryCall = mockCreate.mock.calls[1][0] as {
        messages: { role: string; content: string }[];
      };
      expect(retryCall.messages.some((m) => m.role === 'assistant' && m.content === '')).toBe(
        false,
      );
      expect(retryCall.messages.at(-1)?.role).toBe('user');
    });

    it('should not append a whitespace-only assistant turn on retry either — there is nothing to echo', async () => {
      mockCreate
        .mockResolvedValueOnce(buildMessage('   \n\t', {}, 'end_turn'))
        .mockResolvedValueOnce(buildMessage('{"answer":"Paris"}', {}, 'end_turn'));
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      await provider.generate(requestWithSchema);

      const retryCall = mockCreate.mock.calls[1][0] as {
        messages: { role: string; content: string }[];
      };
      expect(retryCall.messages.some((m) => m.role === 'assistant')).toBe(false);
      expect(retryCall.messages.at(-1)?.role).toBe('user');
    });
  });

  describe('cache_control', () => {
    it('should wrap a present system prompt as a single ephemeral-cache text block, not the plain-string shorthand', async () => {
      mockCreate.mockResolvedValueOnce(buildMessage('Paris'));
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      await provider.generate({ ...baseRequest, system: 'You are a careful assistant.' });

      const call = mockCreate.mock.calls[0][0] as { system: unknown };
      expect(call.system).toEqual([
        {
          type: 'text',
          text: 'You are a careful assistant.',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('should send no system param at all when the request carries none', async () => {
      mockCreate.mockResolvedValueOnce(buildMessage('Paris'));
      const provider = new AnthropicModelProvider(getMockTypedConfig());

      await provider.generate(baseRequest);

      const call = mockCreate.mock.calls[0][0] as { system: unknown };
      expect(call.system).toBeUndefined();
    });
  });

  describe('per-taskClass model routing', () => {
    // The inertness pin: draws its expectation from `validateEnvironment`'s own real defaults,
    // never from a value this test supplies, so a change to either default would fail it —
    // verified by temporarily hardcoding `resolveModel` to return the haiku model for
    // `fact_extraction` and confirming this test fails, then restoring it.
    it('should route every task class to the real ANTHROPIC_MODEL default when ANTHROPIC_MODEL_FACT_EXTRACTION is unset', () => {
      const real = validateEnvironment({});
      expect(real.anthropic.factExtractionModel).toBeUndefined();

      const config = getMockTypedConfig({ anthropic: real.anthropic });
      const provider = new AnthropicModelProvider(config);

      expect(provider.resolveModel('qa_answer')).toBe(real.anthropic.model);
      expect(provider.resolveModel('fact_extraction')).toBe(real.anthropic.model);
      expect(provider.resolveModel('claim_verification')).toBe(real.anthropic.model);
    });

    it('should route fact_extraction to the configured override, leaving qa_answer and claim_verification pinned to the default', () => {
      const config = getMockTypedConfig({
        anthropic: {
          apiKey: undefined,
          model: 'claude-sonnet-5',
          timeoutMs: 60000,
          factExtractionModel: 'claude-haiku-4-5-20251001',
        },
      });
      const provider = new AnthropicModelProvider(config);

      expect(provider.resolveModel('fact_extraction')).toBe('claude-haiku-4-5-20251001');
      expect(provider.resolveModel('qa_answer')).toBe('claude-sonnet-5');
      expect(provider.resolveModel('claim_verification')).toBe('claude-sonnet-5');
    });

    it('should send the resolved model to the SDK and price costUsd against it, not against info.model', async () => {
      const config = getMockTypedConfig({
        anthropic: {
          apiKey: undefined,
          model: 'claude-sonnet-5',
          timeoutMs: 60000,
          factExtractionModel: 'claude-haiku-4-5-20251001',
        },
      });
      mockCreate.mockResolvedValueOnce(
        buildMessage('extracted', { input_tokens: 1000, output_tokens: 100 }),
      );
      const provider = new AnthropicModelProvider(config);

      const result = await provider.generate({ ...baseRequest, taskClass: 'fact_extraction' });

      expect(mockCreate.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-4-5-20251001' });
      const sonnetPrice = computeAnthropicCostUsd('claude-sonnet-5', {
        inputTokens: 1000,
        outputTokens: 100,
        cacheCreation5mInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        cacheReadInputTokens: 0,
      });
      const haikuPrice = computeAnthropicCostUsd('claude-haiku-4-5-20251001', {
        inputTokens: 1000,
        outputTokens: 100,
        cacheCreation5mInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        cacheReadInputTokens: 0,
      });
      expect(sonnetPrice).not.toBeCloseTo(haikuPrice, 10);
      expect(result.costUsd).toBeCloseTo(haikuPrice, 10);
    });

    it('should refuse a fact_extraction call before issuing any request when the override names a model with no pricing entry', async () => {
      const config = getMockTypedConfig({
        anthropic: {
          apiKey: undefined,
          model: 'claude-sonnet-5',
          timeoutMs: 60000,
          factExtractionModel: 'claude-unpriced',
        },
      });
      const provider = new AnthropicModelProvider(config);

      await expect(
        provider.generate({ ...baseRequest, taskClass: 'fact_extraction' }),
      ).rejects.toBeInstanceOf(UnknownModelPricingError);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});
