import { z } from 'zod/v4';
import { computeAnthropicCostUsd } from '../../../src/providers/model/anthropic-pricing.table';
import { ModelBudgetExceededError } from '../../../src/providers/model/errors/model-budget-exceeded.error';
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

function buildMessage(text: string, usage: Partial<Anthropic.Usage> = {}): Anthropic.Message {
  return {
    id: 'msg_test',
    container: null,
    content: [{ type: 'text', text, citations: null }],
    model: 'claude-sonnet-5',
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
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

  it('should refuse the call before issuing any request when the worst-case estimate exceeds maxCostUsd', async () => {
    const provider = new AnthropicModelProvider(getMockTypedConfig());

    await expect(provider.generate({ ...baseRequest, maxCostUsd: 0 })).rejects.toBeInstanceOf(
      ModelBudgetExceededError,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should refuse the call before issuing any request for a model with no pricing entry', async () => {
    const config = getMockTypedConfig({
      anthropic: { apiKey: undefined, model: 'claude-unpriced' },
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

    it('should retry exactly once and succeed when the retry output validates', async () => {
      mockCreate
        .mockResolvedValueOnce(buildMessage('not json', { input_tokens: 10, output_tokens: 5 }))
        .mockResolvedValueOnce(
          buildMessage('{"answer":"Paris"}', { input_tokens: 20, output_tokens: 8 }),
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
});
