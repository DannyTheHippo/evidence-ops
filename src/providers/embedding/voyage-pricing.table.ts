import { UnknownModelPricingError } from '../model/errors/unknown-model-pricing.error';

export interface VoyagePricePerMillion {
  readonly input: number;
}

/**
 * USD price per 1M input tokens. Single source for these numbers — a price change is a one-line
 * edit here, never a scattered find-and-replace. Embeddings have no output token component —
 * unlike `OPENAI_PRICING`/`ANTHROPIC_PRICING`, there is only one rate per model.
 *
 * Only models with a confirmed rate are listed. An unlisted model throws via
 * `computeVoyageCostUsd` instead of silently costing $0 or carrying a guessed rate, so a model
 * this table has not been updated for fails loudly rather than defeating every spend check
 * downstream of it.
 */
export const VOYAGE_PRICING: Readonly<Record<string, VoyagePricePerMillion>> = {
  'voyage-4': { input: 0.06 },
  'voyage-4-lite': { input: 0.02 },
  'voyage-4-large': { input: 0.12 },
  'voyage-context-4': { input: 0.12 },
  'voyage-code-4': { input: 0.12 },
};

export function computeVoyageCostUsd(model: string, totalTokens: number): number {
  const pricing = VOYAGE_PRICING[model];
  if (!pricing) {
    throw new UnknownModelPricingError(model, 'Voyage', 'voyage-pricing.table.ts');
  }

  return (totalTokens * pricing.input) / 1_000_000;
}
