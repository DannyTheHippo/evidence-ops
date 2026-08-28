import type { AdjudicationSample, ClaimOutcome } from './types';

/** Every gate failure is adjudicated at or below this population size; above it, exactly this many
 *  are drawn. This bound is pre-registered and fixed. */
export const MAX_ADJUDICATION_SAMPLE = 20;

/**
 * A seeded 32-bit generator (mulberry32), inline rather than a dependency. Its job is a
 * reproducible draw recorded alongside its seed, not statistical quality — and the drawn claim ids
 * are persisted with the sample, so a run stays reproducible even if this generator is replaced.
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draws the claims a human adjudicates: all of them at or below {@link MAX_ADJUDICATION_SAMPLE},
 * otherwise a seeded uniform draw without replacement. The drawn ids are returned in the
 * population's own order so the worksheet reads in claim order; the draw itself is order-independent.
 */
export function sampleForAdjudication(
  population: readonly ClaimOutcome[],
  seed: number,
): AdjudicationSample {
  if (population.length <= MAX_ADJUDICATION_SAMPLE) {
    return {
      seed,
      populationSize: population.length,
      claimIds: population.map((outcome) => outcome.claimId),
    };
  }

  const indices = population.map((_, index) => index);
  const random = createRandom(seed);
  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [indices[index], indices[swapWith]] = [indices[swapWith], indices[index]];
  }

  const drawn = indices
    .slice(0, MAX_ADJUDICATION_SAMPLE)
    .sort((left, right) => left - right)
    .map((index) => population[index].claimId);

  return { seed, populationSize: population.length, claimIds: drawn };
}
