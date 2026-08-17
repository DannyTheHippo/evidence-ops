import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type CanonicalEntityDocument = HydratedDocument<WithTimestamps<CanonicalEntity>>;

/**
 * Trims, collapses internal whitespace runs to a single space, and lowercases — the exact form
 * stored in `canonicalNameNormalized`/`aliasesNormalized` (derived below by a `pre('validate')`
 * hook) and the form a lookup must produce from its own input to match them.
 * `CanonicalEntityService.resolve` is the sole read-path caller; a lookup that normalises a name
 * differently from how it was stored would silently miss it.
 */
export function normalizeEntityName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Per-tenant registry mapping known alternate spellings of an entity name to one canonical display
 * name — e.g. "Northgate Bus. Park" and "Northgate Business Park" both resolving to the same
 * canonical name, so conflict detection's grouping (keyed on entity name) actually sees the two as
 * one entity. Matching is exact and alias-only, never fuzzy or edit-distance: a name with no exact
 * match against `canonicalNameNormalized` or `aliasesNormalized` stays unmatched rather than being
 * guessed at, because a fuzzy match here would fabricate an agreement — or a conflict — between two
 * properties that were never actually the same.
 */
@Schema({ timestamps: true, collection: 'canonical_entities' })
export class CanonicalEntity extends AuditableDocument {
  @Prop({ type: String, required: true })
  tenantId: string;

  @Prop({ type: String, required: true, trim: true })
  canonicalName: string;

  /** `canonicalName` normalised via {@link normalizeEntityName}, stored alongside the display form
   * so an exact-match lookup never has to re-derive it. Derived automatically by the
   * `pre('validate')` hook below from `canonicalName` — a caller sets `canonicalName` and never
   * writes this field directly. */
  @Prop({ type: String, required: true })
  canonicalNameNormalized: string;

  @Prop({ type: [String], default: [] })
  aliases: string[];

  /** Each entry of `aliases`, normalised via {@link normalizeEntityName} — same role and same
   * derivation as `canonicalNameNormalized`, one entry per alias. */
  @Prop({ type: [String], default: [] })
  aliasesNormalized: string[];
}

export const CanonicalEntitySchema = SchemaFactory.createForClass(CanonicalEntity);

/**
 * Derives `canonicalNameNormalized`/`aliasesNormalized` from `canonicalName`/`aliases` on every
 * validate pass — `save()`/`create()` and any other path that runs document validation — so the
 * normalised fields can never drift out of sync with the display fields they are computed from.
 * `pre('validate')` runs before the `required` path validators, so `canonicalNameNormalized`
 * still passes its own `required` check on a freshly constructed document. Does not fire on
 * `updateOne`/`findOneAndUpdate`-style updates (Mongoose only runs document middleware on
 * document `save()`), which is not a gap today — this registry has no update path yet.
 */
CanonicalEntitySchema.pre('validate', function (this: CanonicalEntityDocument): void {
  this.canonicalNameNormalized = normalizeEntityName(this.canonicalName);
  this.aliasesNormalized = this.aliases.map(normalizeEntityName);
});

/**
 * Declared here as well as in `migrations/0018-canonical-entities.ts`, with the same keys, options
 * and names — see `source.schema.ts`'s identical pair for why: the migration builds them in a
 * deployed database, these declarations are what `Model.syncIndexes()` builds, which is how a test
 * lane that never runs migrations still enforces the uniqueness this registry relies on.
 */
CanonicalEntitySchema.index(
  { tenantId: 1, canonicalNameNormalized: 1 },
  { unique: true, name: 'canonical_entities_tenantId_canonicalNameNormalized_unique' },
);
CanonicalEntitySchema.index(
  { tenantId: 1, aliasesNormalized: 1 },
  { name: 'canonical_entities_tenantId_aliasesNormalized' },
);
