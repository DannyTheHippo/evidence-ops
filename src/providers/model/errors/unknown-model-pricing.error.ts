/**
 * Thrown when a model id has no entry in a provider's pricing table. Fails closed rather than
 * silently costing the call at $0 — an unpriced model would otherwise defeat every budget check
 * downstream of it. Shared across providers; `provider`/`tableFile` default to the Anthropic
 * table so every existing call site keeps its original message unchanged.
 */
export class UnknownModelPricingError extends Error {
  constructor(
    public readonly model: string,
    provider = 'Anthropic',
    tableFile = 'anthropic-pricing.table.ts',
  ) {
    super(`No pricing entry for ${provider} model '${model}' — add it to ${tableFile}`);
    this.name = 'UnknownModelPricingError';
  }
}
