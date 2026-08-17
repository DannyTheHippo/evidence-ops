import { UnknownModelPricingError } from './errors/unknown-model-pricing.error';

export interface OpenAiPricePerMillion {
  readonly input: number;
  readonly output: number;
  /** OpenAI discounts the portion of `input_tokens` served from its own prompt cache — unlike
   * Anthropic, there is no separate cache-write price, only this cache-read rate. */
  readonly cachedInput: number;
}

/**
 * USD price per 1M tokens. Single source for these numbers — a price change is a one-line edit
 * here, never a scattered find-and-replace.
 *
 * Self-hosted models (vLLM/Ollama) are priced at zero explicitly, never by omission — an
 * unlisted model throws via `computeOpenAiCostUsd` instead of silently costing $0, so a real
 * hosted model missing from this table fails loudly rather than defeating every budget check.
 */
export const OPENAI_PRICING: Readonly<Record<string, OpenAiPricePerMillion>> = {
  'gpt-5': { input: 1.25, output: 10, cachedInput: 0.125 },
  'gpt-5-mini': { input: 0.25, output: 2, cachedInput: 0.025 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cachedInput: 0.005 },
  'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cachedInput: 0.075 },
  // Self-hosted, served locally — genuinely free per token, stated explicitly rather than left
  // absent from this table.
  'llama-3.1-70b-instruct': { input: 0, output: 0, cachedInput: 0 },
  'llama-3.1-8b-instruct': { input: 0, output: 0, cachedInput: 0 },
};

export interface OpenAiCostUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Subset of `inputTokens` served from OpenAI's prompt cache, billed at `cachedInput` instead
   * of `input`. */
  readonly cachedInputTokens: number;
}

export function computeOpenAiCostUsd(model: string, usage: OpenAiCostUsage): number {
  const pricing = OPENAI_PRICING[model];
  if (!pricing) {
    throw new UnknownModelPricingError(model, 'OpenAI', 'openai-pricing.table.ts');
  }

  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens;
  const inputCostPerMillion =
    uncachedInputTokens * pricing.input + usage.cachedInputTokens * pricing.cachedInput;
  const outputCostPerMillion = usage.outputTokens * pricing.output;

  return (inputCostPerMillion + outputCostPerMillion) / 1_000_000;
}
