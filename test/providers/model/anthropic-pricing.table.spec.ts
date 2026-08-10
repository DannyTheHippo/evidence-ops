import {
  ANTHROPIC_CACHE_MULTIPLIERS,
  computeAnthropicCostUsd,
} from '../../../src/providers/model/anthropic-pricing.table';
import { UnknownModelPricingError } from '../../../src/providers/model/errors/unknown-model-pricing.error';

describe('computeAnthropicCostUsd', () => {
  const zeroUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  it("should price input and output tokens at the model's per-million rate", () => {
    const cost = computeAnthropicCostUsd('claude-sonnet-5', {
      ...zeroUsage,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(3 + 15, 10);
  });

  it('should apply the 5-minute cache-write multiplier to the input price only', () => {
    const cost = computeAnthropicCostUsd('claude-sonnet-5', {
      ...zeroUsage,
      cacheCreation5mInputTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(3 * ANTHROPIC_CACHE_MULTIPLIERS.write5m, 10);
  });

  it('should apply the 1-hour cache-write multiplier to the input price only', () => {
    const cost = computeAnthropicCostUsd('claude-sonnet-5', {
      ...zeroUsage,
      cacheCreation1hInputTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(3 * ANTHROPIC_CACHE_MULTIPLIERS.write1h, 10);
  });

  it('should apply the cache-read multiplier to the input price only', () => {
    const cost = computeAnthropicCostUsd('claude-sonnet-5', {
      ...zeroUsage,
      cacheReadInputTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(3 * ANTHROPIC_CACHE_MULTIPLIERS.read, 10);
  });

  it('should sum every usage component into a single cost', () => {
    const cost = computeAnthropicCostUsd('claude-haiku-4-5-20251001', {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheCreation5mInputTokens: 10_000,
      cacheCreation1hInputTokens: 5_000,
      cacheReadInputTokens: 20_000,
    });

    const expected =
      (100_000 * 1 +
        10_000 * 1 * ANTHROPIC_CACHE_MULTIPLIERS.write5m +
        5_000 * 1 * ANTHROPIC_CACHE_MULTIPLIERS.write1h +
        20_000 * 1 * ANTHROPIC_CACHE_MULTIPLIERS.read +
        50_000 * 5) /
      1_000_000;

    expect(cost).toBeCloseTo(expected, 10);
  });

  it('should throw UnknownModelPricingError for a model with no pricing entry', () => {
    expect(() => computeAnthropicCostUsd('claude-nonexistent', zeroUsage)).toThrow(
      UnknownModelPricingError,
    );
  });
});
