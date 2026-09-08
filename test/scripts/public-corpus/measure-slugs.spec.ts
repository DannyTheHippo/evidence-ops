import { MEASURE_SLUGS } from '../../../scripts/public-corpus/lib/measure-slugs';

describe('MEASURE_SLUGS', () => {
  it('carries exactly eighteen unique slugs', () => {
    expect(MEASURE_SLUGS).toHaveLength(18);
    expect(new Set(MEASURE_SLUGS).size).toBe(18);
  });

  it('carries only non-empty snake_case slugs', () => {
    for (const slug of MEASURE_SLUGS) {
      expect(slug).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
