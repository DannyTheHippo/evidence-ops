/**
 * Thrown when a model id has no entry in `anthropic-pricing.table.ts`. Fails closed rather than
 * silently costing the call at $0 — an unpriced model would otherwise defeat every budget check
 * downstream of it.
 */
export class UnknownModelPricingError extends Error {
  constructor(public readonly model: string) {
    super(`No pricing entry for Anthropic model '${model}' — add it to anthropic-pricing.table.ts`);
    this.name = 'UnknownModelPricingError';
  }
}
