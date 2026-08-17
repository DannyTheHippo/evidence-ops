import {
  computeOpenAiCostUsd,
  OPENAI_PRICING,
} from '../../../src/providers/model/openai-pricing.table';
import { UnknownModelPricingError } from '../../../src/providers/model/errors/unknown-model-pricing.error';

describe('computeOpenAiCostUsd', () => {
  const zeroUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

  it("should price input and output tokens at the model's per-million rate", () => {
    const cost = computeOpenAiCostUsd('gpt-5', {
      ...zeroUsage,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(1.25 + 10, 10);
  });

  it('should price the cached portion of input tokens at the cached-input rate, not the standard input rate', () => {
    const cost = computeOpenAiCostUsd('gpt-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(OPENAI_PRICING['gpt-5'].cachedInput, 10);
  });

  it('should price only the uncached remainder at the standard input rate when input is partially cached', () => {
    const cost = computeOpenAiCostUsd('gpt-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 400_000,
    });

    const expected =
      (600_000 * OPENAI_PRICING['gpt-5'].input + 400_000 * OPENAI_PRICING['gpt-5'].cachedInput) /
      1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('should price a self-hosted model at zero from its explicit zero-price entry', () => {
    const cost = computeOpenAiCostUsd('llama-3.1-70b-instruct', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 500_000,
    });

    expect(cost).toBe(0);
  });

  it('should throw UnknownModelPricingError for a model with no pricing entry', () => {
    expect(() => computeOpenAiCostUsd('gpt-nonexistent', zeroUsage)).toThrow(
      UnknownModelPricingError,
    );
  });

  it('should name the OpenAI table in the thrown error, not the Anthropic one', () => {
    expect(() => computeOpenAiCostUsd('gpt-nonexistent', zeroUsage)).toThrow(
      /OpenAI model 'gpt-nonexistent'.*openai-pricing\.table\.ts/,
    );
  });
});
