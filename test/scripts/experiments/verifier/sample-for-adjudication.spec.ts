import {
  MAX_ADJUDICATION_SAMPLE,
  sampleForAdjudication,
} from '../../../../scripts/experiments/verifier/sample-for-adjudication';
import { makeOutcomes } from './verifier-fixtures';

describe('sampleForAdjudication', () => {
  it('takes every claim when the population is at or below the cap', () => {
    const population = makeOutcomes(MAX_ADJUDICATION_SAMPLE, 'not_grounded');

    const sample = sampleForAdjudication(population, 7);

    expect(sample.claimIds).toEqual(population.map((outcome) => outcome.claimId));
    expect(sample.populationSize).toBe(MAX_ADJUDICATION_SAMPLE);
    expect(sample.seed).toBe(7);
  });

  it('handles an empty population', () => {
    expect(sampleForAdjudication([], 7)).toEqual({ seed: 7, populationSize: 0, claimIds: [] });
  });

  it('draws exactly the cap above it, and records the population it drew from', () => {
    const population = makeOutcomes(57, 'not_grounded');

    const sample = sampleForAdjudication(population, 7);

    expect(sample.claimIds).toHaveLength(MAX_ADJUDICATION_SAMPLE);
    expect(new Set(sample.claimIds).size).toBe(MAX_ADJUDICATION_SAMPLE);
    expect(sample.populationSize).toBe(57);
    for (const claimId of sample.claimIds) {
      expect(population.some((outcome) => outcome.claimId === claimId)).toBe(true);
    }
  });

  it('reproduces the same draw for the same seed and differs for another', () => {
    const population = makeOutcomes(57, 'not_grounded');

    expect(sampleForAdjudication(population, 7).claimIds).toEqual(
      sampleForAdjudication(population, 7).claimIds,
    );
    expect(sampleForAdjudication(population, 8).claimIds).not.toEqual(
      sampleForAdjudication(population, 7).claimIds,
    );
  });

  it('returns the drawn ids in population order', () => {
    const population = makeOutcomes(57, 'not_grounded');

    const { claimIds } = sampleForAdjudication(population, 7);
    const positions = claimIds.map((claimId) =>
      population.findIndex((outcome) => outcome.claimId === claimId),
    );

    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});
