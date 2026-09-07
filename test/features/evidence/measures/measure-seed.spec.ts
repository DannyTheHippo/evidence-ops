import type { Model } from 'mongoose';
import { getMockModel } from '../../../utils/get-mock-model';
import {
  METRIC_IDS,
  METRIC_ONTOLOGY,
} from '../../../../src/features/evidence/facts/metric-ontology';
import type { MeasureDocument } from '../../../../src/database/schemas/evidence/measure/measure.schema';
import {
  buildSeedMeasureRows,
  seedMeasures,
} from '../../../../src/features/evidence/measures/measure-seed';

describe('buildSeedMeasureRows', () => {
  it('mints exactly one row per METRIC_ONTOLOGY entry, in ontology order', () => {
    const rows = buildSeedMeasureRows('tenant-a');

    expect(rows.map((row) => row.slug)).toEqual(METRIC_ONTOLOGY.map((metric) => metric.id));
  });

  it('mints a slug for every METRIC_IDS entry', () => {
    const rows = buildSeedMeasureRows('tenant-a');

    expect(new Set(rows.map((row) => row.slug))).toEqual(new Set(METRIC_IDS));
  });

  it('stamps every row confirmed, seed, version 1, for the given tenant', () => {
    const rows = buildSeedMeasureRows('tenant-a');

    for (const row of rows) {
      expect(row.tenantId).toBe('tenant-a');
      expect(row.status).toBe('confirmed');
      expect(row.origin).toBe('seed');
      expect(row.version).toBe(1);
      expect(row.proposedFrom).toEqual([]);
    }
  });

  it('stamps createdAt/updatedAt to the supplied now, identically for every row', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    const rows = buildSeedMeasureRows('tenant-a', now);

    for (const row of rows) {
      expect(row.createdAt).toBe(now);
      expect(row.updatedAt).toBe(now);
    }
  });

  it('carries authorityOrder only for a metric that configures one, never as an empty array', () => {
    const rows = buildSeedMeasureRows('tenant-a');

    for (const row of rows) {
      const metric = METRIC_ONTOLOGY.find((entry) => entry.id === row.slug);
      if (metric?.authorityOrder === undefined) {
        expect('authorityOrder' in row).toBe(false);
      } else {
        expect(row.authorityOrder).toEqual(metric.authorityOrder);
      }
    }
  });

  it('carries stalenessWindowMs only for a metric that configures one', () => {
    const rows = buildSeedMeasureRows('tenant-a');

    for (const row of rows) {
      const metric = METRIC_ONTOLOGY.find((entry) => entry.id === row.slug);
      if (metric?.stalenessWindowMs === undefined) {
        expect('stalenessWindowMs' in row).toBe(false);
      } else {
        expect(row.stalenessWindowMs).toBe(metric.stalenessWindowMs);
      }
    }
  });

  it('never mints an undefined-valued key', () => {
    const rows = buildSeedMeasureRows('tenant-a');

    for (const row of rows) {
      for (const value of Object.values(row)) {
        expect(value).not.toBeUndefined();
      }
    }
  });

  it('projects field-for-field from METRIC_ONTOLOGY (aliases, valueType, canonicalUnit, units, tolerance)', () => {
    const rows = buildSeedMeasureRows('tenant-a');

    for (const row of rows) {
      const metric = METRIC_ONTOLOGY.find((entry) => entry.id === row.slug);
      expect(row.label).toBe(metric?.label);
      expect(row.aliases).toEqual(metric?.aliases);
      expect(row.valueType).toBe(metric?.valueType);
      expect(row.canonicalUnit).toBe(metric?.canonicalUnit);
      expect(row.units).toEqual(metric?.units);
      expect(row.toleranceKind).toBe(metric?.toleranceKind);
      expect(row.tolerance).toBe(metric?.tolerance);
    }
  });
});

describe('seedMeasures', () => {
  it('inserts one buildSeedMeasureRows-shaped row per METRIC_ONTOLOGY entry in one insertMany call', async () => {
    const model = getMockModel<{
      tenantId: string;
      slug: string;
      createdAt: Date;
      updatedAt: Date;
    }>();
    model.insertMany.mockResolvedValue([]);

    await seedMeasures(model as unknown as Model<MeasureDocument>, 'tenant-a');

    expect(model.insertMany).toHaveBeenCalledTimes(1);
    const [inserted] = model.insertMany.mock.calls[0] as [
      { tenantId: string; slug: string; createdAt: Date; updatedAt: Date }[],
    ];
    expect(inserted).toHaveLength(METRIC_ONTOLOGY.length);
    expect(inserted.map((row) => row.slug)).toEqual(METRIC_ONTOLOGY.map((metric) => metric.id));
    for (const row of inserted) {
      expect(row.tenantId).toBe('tenant-a');
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toEqual(row.createdAt);
    }
  });
});
