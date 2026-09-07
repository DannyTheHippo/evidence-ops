import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import {
  Measure,
  MeasureDocument,
} from '../../src/database/schemas/evidence/measure/measure.schema';

export interface MeasureStamp {
  measureId: Types.ObjectId;
  measureVersion: number;
  measureStatus: 'confirmed';
}

/**
 * An `ExtractedFact` created anywhere under `test/` — via `create`, `insertMany`, a mocked-model
 * return value, or a plain literal typed as a fact — carries `measureId`, `measureVersion` and
 * `measureStatus`, because the schema now requires all three. Every fixture stamps `confirmed`
 * unless the test is specifically about a proposed measure, in which case it overrides
 * `measureStatus` to `'proposed'` deliberately rather than calling this helper.
 *
 * Resolves the tenant's seeded `Measure` row by `{ tenantId, slug }` and stamps its real `_id` and
 * `version` — not a fabricated id — so a fact's provenance actually points at a row the tenant
 * owns. Throws when no row is found: the tenant was not registered through `POST /auth/register`
 * (which seeds every ontology measure on tenant birth), so no measure of that slug exists for it.
 */
export const measureStamp = async (
  app: INestApplication,
  tenantId: string,
  slug: string,
): Promise<MeasureStamp> => {
  const measureModel = app.get<Model<MeasureDocument>>(getModelToken(Measure.name));
  const measure = await measureModel.findOne({ tenantId, slug });
  if (!measure) {
    throw new Error(
      `measureStamp: no seeded Measure for tenant '${tenantId}' slug '${slug}' — was this ` +
        'tenant registered through POST /auth/register?',
    );
  }

  return { measureId: measure._id, measureVersion: measure.version, measureStatus: 'confirmed' };
};

/**
 * `measureStamp`'s counterpart for unit specs, where no app or seeded tenant exists to resolve
 * against: a fresh `ObjectId` stands in for provenance the mocked model never validates. `slug` is
 * accepted but unused — it exists so a call site can stay self-documenting about which measure a
 * fixture represents, the same way `measureStamp`'s `slug` argument does.
 */
export const unitMeasureStamp = (_slug?: string): MeasureStamp => ({
  measureId: new Types.ObjectId(),
  measureVersion: 1,
  measureStatus: 'confirmed',
});
