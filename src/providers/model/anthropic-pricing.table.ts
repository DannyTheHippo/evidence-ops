import { UnknownModelPricingError } from './errors/unknown-model-pricing.error';

export interface AnthropicPricePerMillion {
  readonly input: number;
  readonly output: number;
}

/**
 * USD price per 1M tokens. Single source for these numbers — a price change is a one-line
 * edit here, never a scattered find-and-replace.
 */
export const ANTHROPIC_PRICING: Readonly<Record<string, AnthropicPricePerMillion>> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

/** Multipliers apply to the input price only; output tokens are never cached. */
export const ANTHROPIC_CACHE_MULTIPLIERS = {
  write5m: 1.25,
  write1h: 2.0,
  read: 0.1,
} as const;

export interface AnthropicCostUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreation5mInputTokens: number;
  readonly cacheCreation1hInputTokens: number;
  readonly cacheReadInputTokens: number;
}

/**
 * `usage.cache_creation_input_tokens` alone can't be priced — the 5-minute and 1-hour write
 * tiers carry different multipliers, and only the `cache_creation` breakdown on the raw
 * Anthropic response distinguishes them. Callers map that breakdown into `AnthropicCostUsage`
 * before calling this.
 */
export function computeAnthropicCostUsd(model: string, usage: AnthropicCostUsage): number {
  const pricing = ANTHROPIC_PRICING[model];
  if (!pricing) {
    throw new UnknownModelPricingError(model);
  }

  const inputCostPerMillion =
    usage.inputTokens * pricing.input +
    usage.cacheCreation5mInputTokens * pricing.input * ANTHROPIC_CACHE_MULTIPLIERS.write5m +
    usage.cacheCreation1hInputTokens * pricing.input * ANTHROPIC_CACHE_MULTIPLIERS.write1h +
    usage.cacheReadInputTokens * pricing.input * ANTHROPIC_CACHE_MULTIPLIERS.read;

  const outputCostPerMillion = usage.outputTokens * pricing.output;

  return (inputCostPerMillion + outputCostPerMillion) / 1_000_000;
}
