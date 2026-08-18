import { UnknownModelPricingError } from '../../../src/providers/model/errors/unknown-model-pricing.error';
import {
  computeVoyageCostUsd,
  VOYAGE_PRICING,
} from '../../../src/providers/embedding/voyage-pricing.table';

describe('computeVoyageCostUsd', () => {
  it("should price tokens at the model's per-million input rate", () => {
    const cost = computeVoyageCostUsd('voyage-4', 1_000_000);

    expect(cost).toBeCloseTo(VOYAGE_PRICING['voyage-4'].input, 10);
  });

  it('should price a fractional token count proportionally', () => {
    const cost = computeVoyageCostUsd('voyage-4-lite', 500_000);

    expect(cost).toBeCloseTo(VOYAGE_PRICING['voyage-4-lite'].input / 2, 10);
  });

  it('should price zero tokens at zero cost', () => {
    expect(computeVoyageCostUsd('voyage-4', 0)).toBe(0);
  });

  it('should throw UnknownModelPricingError for a model with no pricing entry', () => {
    expect(() => computeVoyageCostUsd('voyage-nonexistent', 1000)).toThrow(
      UnknownModelPricingError,
    );
  });

  it('should name the Voyage table in the thrown error, not the Anthropic default', () => {
    expect(() => computeVoyageCostUsd('voyage-nonexistent', 1000)).toThrow(
      /Voyage model 'voyage-nonexistent'.*voyage-pricing\.table\.ts/,
    );
  });
});
