import { PUBLIC_MEASURES } from '../../eval/ingest-public-corpus';
import { validateMeasureDefinition } from '../../src/features/evidence/measures/measure-definition';
import { MEASURE_SLUGS } from '../../scripts/public-corpus/lib/measure-slugs';

describe('eval/public/measures.json', () => {
  it('should carry exactly the slug set MEASURE_SLUGS declares', () => {
    const slugs = PUBLIC_MEASURES.map((measure) => measure.slug);

    expect(new Set(slugs)).toEqual(new Set(MEASURE_SLUGS));
    expect(slugs).toHaveLength(MEASURE_SLUGS.length);
  });

  it('should have unique slugs', () => {
    const slugs = PUBLIC_MEASURES.map((measure) => measure.slug);

    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('should be confirmed, manually-originated rows', () => {
    for (const measure of PUBLIC_MEASURES) {
      expect(measure.status).toBe('confirmed');
      expect(measure.origin).toBe('manual');
    }
  });

  it('should satisfy every rule validateMeasureDefinition enforces on a Measure row', () => {
    for (const measure of PUBLIC_MEASURES) {
      expect(() => validateMeasureDefinition(measure)).not.toThrow();
    }
  });
});
