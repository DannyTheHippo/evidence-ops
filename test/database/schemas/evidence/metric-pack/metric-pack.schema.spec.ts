import mongoose from 'mongoose';
import {
  MetricPack,
  MetricPackSchema,
} from '../../../../../src/database/schemas/evidence/metric-pack/metric-pack.schema';

const metrics = [
  {
    id: 'cap_rate',
    label: 'Cap Rate',
    aliases: ['Cap Rate'],
    valueType: 'percentage',
    canonicalUnit: 'ratio',
    units: [{ id: 'ratio', toCanonicalFactor: 1 }],
    toleranceKind: 'absolute',
    tolerance: 0.0025,
  },
];

describe('MetricPack schema', () => {
  describe('validation (offline — no database connection)', () => {
    const MetricPackModel = mongoose.model<MetricPack>(
      'MetricPackValidationOnly',
      MetricPackSchema,
    );

    // `metrics` is not asserted here despite `required: true`: Mongoose defaults an array path to
    // `[]`, which satisfies `required` trivially — same caveat `EvidenceChunk.embedding`'s own
    // comment documents.
    it('requires tenantId, packId, version, status, and label', () => {
      const pack = new MetricPackModel({});

      const error = pack.validateSync();

      expect(error?.errors.tenantId).toBeDefined();
      expect(error?.errors.packId).toBeDefined();
      expect(error?.errors.version).toBeDefined();
      expect(error?.errors.status).toBeDefined();
      expect(error?.errors.label).toBeDefined();
    });

    // The reservation this guards: a tenant-authored row claiming the code default's id would make
    // `(packId, version)` ambiguous between the code pack and a stored row.
    it("rejects the reserved 'cre' packId", () => {
      const pack = new MetricPackModel({
        tenantId: 'tenant-a',
        packId: 'cre',
        version: 1,
        status: 'draft',
        label: 'CRE Fork',
        metrics,
      });

      const error = pack.validateSync();

      expect(error?.errors.packId).toBeDefined();
    });

    it('accepts a non-reserved packId', () => {
      const pack = new MetricPackModel({
        tenantId: 'tenant-a',
        packId: 'cre-fork',
        version: 1,
        status: 'draft',
        label: 'CRE Fork',
        metrics,
      });

      expect(pack.validateSync()).toBeUndefined();
    });

    it('rejects a non-integer version', () => {
      const pack = new MetricPackModel({
        tenantId: 'tenant-a',
        packId: 'cre-fork',
        version: 1.5,
        status: 'draft',
        label: 'CRE Fork',
        metrics,
      });

      const error = pack.validateSync();

      expect(error?.errors.version).toBeDefined();
    });

    it('rejects a status outside the declared enum', () => {
      const pack = new MetricPackModel({
        tenantId: 'tenant-a',
        packId: 'cre-fork',
        version: 1,
        status: 'live',
        label: 'CRE Fork',
        metrics,
      });

      const error = pack.validateSync();

      expect(error?.errors.status).toBeDefined();
    });
  });
});
