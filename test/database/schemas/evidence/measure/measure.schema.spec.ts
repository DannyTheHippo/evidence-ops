import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, createConnection, Model } from 'mongoose';
import {
  MAX_PROPOSED_FROM_PER_MEASURE,
  Measure,
  MeasureSchema,
} from '../../../../../src/database/schemas/evidence/measure/measure.schema';

jest.setTimeout(60000);

const buildMeasureInput = () => ({
  tenantId: 'tenant-a',
  slug: 'cap_rate',
  label: 'Cap Rate',
  aliases: ['Cap Rate', 'cap rate', 'capitalization rate'],
  valueType: 'percentage' as const,
  canonicalUnit: 'ratio',
  units: [
    { id: 'ratio', toCanonicalFactor: 1 },
    { id: 'percent', toCanonicalFactor: 0.01 },
  ],
  toleranceKind: 'absolute' as const,
  tolerance: 0.0025,
  status: 'confirmed' as const,
  origin: 'seed' as const,
  proposedFrom: [],
  version: 1,
});

const REQUIRED_FIELDS = [
  'tenantId',
  'slug',
  'label',
  'aliases',
  'valueType',
  'canonicalUnit',
  'units',
  'toleranceKind',
  'tolerance',
  'origin',
  'version',
] as const;

describe('Measure schema', () => {
  describe('validation (offline — no database connection)', () => {
    const MeasureModel = mongoose.model<Measure>('MeasureValidationOnly', MeasureSchema);

    it.each(REQUIRED_FIELDS)('requires %s', (field) => {
      const input = { ...buildMeasureInput() };
      delete (input as Record<string, unknown>)[field];
      const measure = new MeasureModel(input);

      const error = measure.validateSync();

      expect(error?.errors[field]).toBeDefined();
    });

    it('defaults status to proposed when omitted', () => {
      const input = { ...buildMeasureInput() } as Record<string, unknown>;
      delete input.status;
      const measure = new MeasureModel(input);

      expect(measure.status).toBe('proposed');
    });

    it('rejects a status outside proposed/confirmed/rejected', () => {
      const measure = new MeasureModel({ ...buildMeasureInput(), status: 'archived' });

      const error = measure.validateSync();

      expect(error?.errors.status).toBeDefined();
    });

    it('rejects an origin outside seed/header/manual', () => {
      const measure = new MeasureModel({ ...buildMeasureInput(), origin: 'imported' });

      const error = measure.validateSync();

      expect(error?.errors.origin).toBeDefined();
    });

    it('rejects a valueType outside the FactValueType allowlist', () => {
      const measure = new MeasureModel({ ...buildMeasureInput(), valueType: 'weight' });

      const error = measure.validateSync();

      expect(error?.errors.valueType).toBeDefined();
    });

    it('rejects a toleranceKind outside absolute/relative', () => {
      const measure = new MeasureModel({ ...buildMeasureInput(), toleranceKind: 'fuzzy' });

      const error = measure.validateSync();

      expect(error?.errors.toleranceKind).toBeDefined();
    });

    it('rejects a negative tolerance', () => {
      const measure = new MeasureModel({ ...buildMeasureInput(), tolerance: -0.01 });

      const error = measure.validateSync();

      expect(error?.errors.tolerance).toBeDefined();
    });

    it('rejects a version below 1', () => {
      const measure = new MeasureModel({ ...buildMeasureInput(), version: 0 });

      const error = measure.validateSync();

      expect(error?.errors.version).toBeDefined();
    });

    it('rejects an empty units array', () => {
      const measure = new MeasureModel({ ...buildMeasureInput(), units: [] });

      const error = measure.validateSync();

      expect(error?.errors.units).toBeDefined();
    });

    it(`rejects proposedFrom past the ${MAX_PROPOSED_FROM_PER_MEASURE}-entry cap`, () => {
      const evidence = Array.from({ length: MAX_PROPOSED_FROM_PER_MEASURE + 1 }, () => ({
        documentVersionId: new mongoose.Types.ObjectId(),
        locator: {
          kind: 'text-block' as const,
          extractorVersion: 'v1',
          blockIndex: 0,
          headingPath: [],
        },
        headerText: 'Header',
      }));
      const measure = new MeasureModel({ ...buildMeasureInput(), proposedFrom: evidence });

      const error = measure.validateSync();

      expect(error?.errors.proposedFrom).toBeDefined();
    });

    it(`accepts proposedFrom at exactly the ${MAX_PROPOSED_FROM_PER_MEASURE}-entry cap`, () => {
      const evidence = Array.from({ length: MAX_PROPOSED_FROM_PER_MEASURE }, () => ({
        documentVersionId: new mongoose.Types.ObjectId(),
        locator: {
          kind: 'text-block' as const,
          extractorVersion: 'v1',
          blockIndex: 0,
          headingPath: [],
        },
        headerText: 'Header',
      }));
      const measure = new MeasureModel({ ...buildMeasureInput(), proposedFrom: evidence });

      expect(measure.validateSync()).toBeUndefined();
    });

    it('leaves authorityOrder undefined when not supplied', () => {
      const measure = new MeasureModel(buildMeasureInput());

      expect(measure.authorityOrder).toBeUndefined();
      expect(measure.validateSync()).toBeUndefined();
    });
  });

  describe('round-trip via mongodb-memory-server', () => {
    let mongod: MongoMemoryServer;
    let connection: Connection;
    let MeasureModel: Model<Measure>;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await createConnection(mongod.getUri()).asPromise();
      MeasureModel = connection.model<Measure>(Measure.name, MeasureSchema);
      // Waits for the background index build so the duplicate-key case below observes the
      // unique index deterministically rather than racing its own first insert.
      await MeasureModel.init();
    });

    afterAll(async () => {
      await connection.close();
      await mongod.stop();
    });

    // Every persisting case below shares `buildMeasureInput()`'s `{tenantId: 'tenant-a', slug:
    // 'cap_rate'}` — cleared between cases so one case's row never collides with the next's under
    // `measures_tenantId_slug_unique`.
    afterEach(async () => {
      await MeasureModel.deleteMany({});
    });

    it('persists and rehydrates a seed measure without minting an authorityOrder key', async () => {
      const created = await MeasureModel.create(buildMeasureInput());

      const found = await MeasureModel.findById(created._id);
      const plain = found?.toObject();

      expect('authorityOrder' in (plain ?? {})).toBe(false);
      expect(plain?.status).toBe('confirmed');
      expect(plain?.origin).toBe('seed');
      expect(plain?.version).toBe(1);
    });

    it('persists and rehydrates an explicit authorityOrder', async () => {
      const created = await MeasureModel.create({
        ...buildMeasureInput(),
        authorityOrder: ['pm-export', 'spreadsheet'],
      });

      const found = await MeasureModel.findById(created._id);

      expect(found?.authorityOrder).toEqual(['pm-export', 'spreadsheet']);
    });

    it('rejects a second measure with the same tenantId and slug', async () => {
      await MeasureModel.create(buildMeasureInput());

      await expect(MeasureModel.create(buildMeasureInput())).rejects.toThrow(/E11000/);
    });

    it('declares both named indexes', () => {
      const names = MeasureSchema.indexes().map(([, options]) => options.name);

      expect(names).toContain('measures_tenantId_slug_unique');
      expect(names).toContain('measures_tenantId_status_createdAt');
    });
  });
});
