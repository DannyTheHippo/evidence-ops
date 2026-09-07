/**
 * One convertible unit a measure accepts — `toCanonicalFactor` multiplies a value expressed in
 * `id` into the measure's `canonicalUnit` (for example, `sqft` carries the factor that converts
 * into a `sqm`-canonical measure).
 */
export interface VerifierMeasureUnit {
  readonly id: string;
  readonly toCanonicalFactor: number;
}

/**
 * A quantity `parseClaimAssertions`/`verifyStructuredSupport` can recognize inside a claim and
 * match against `GroundingCellFact` values — plain-data, Mongoose-free, like `GroundingCellFact`
 * (`verify-claim.ts`): this module has no Mongoose dependency and stays testable with plain
 * object literals.
 */
export interface VerifierMeasure {
  readonly slug: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly valueType: 'currency' | 'percentage' | 'area' | 'duration' | 'count';
  readonly canonicalUnit: string;
  readonly units: readonly VerifierMeasureUnit[];
  readonly toleranceKind: 'absolute' | 'relative';
  readonly tolerance: number;
}
