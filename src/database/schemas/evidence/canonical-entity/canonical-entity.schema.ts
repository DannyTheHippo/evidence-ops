import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongooseSchema, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import type { EvidenceLocator } from '../evidence-chunk/evidence-locator.type';

export type CanonicalEntityDocument = HydratedDocument<WithTimestamps<CanonicalEntity>>;

/**
 * Lifecycle of an alias read off a document rather than authored by an operator.
 *
 * - `proposed` — recorded with its citation and resolving nothing. The state every harvested alias
 *   lands in while auto-application is off.
 * - `applied` — folded into `aliasesNormalized` by the `pre('validate')` hook below, so it resolves
 *   exactly as an operator-authored alias does, through the same fail-closed ambiguity branch.
 * - `revoked` — an operator has rejected it. Terminal: a later document re-stating the same
 *   definition does not return it to `applied`, or revoking would last only until the next ingest.
 */
export type HarvestedAliasStatus = 'proposed' | 'applied' | 'revoked';

export const HARVESTED_ALIAS_STATUSES: readonly HarvestedAliasStatus[] = [
  'proposed',
  'applied',
  'revoked',
];

/**
 * An alias the document itself defined — `Northgate Business Park (the "Property")` — together
 * with the citation that makes the claim checkable. The quote and locator are what distinguish
 * this from a guess: an author writing a parenthetical definition is stating the alias, so the row
 * carries the evidence rather than a similarity score.
 */
@Schema({ _id: false })
export class HarvestedAlias {
  /** Display form, whitespace-collapsed, as written in the document. */
  @Prop({ type: String, required: true })
  alias: string;

  /** `alias` under {@link normalizeEntityName} — the form the `pre('validate')` hook folds into
   *  `aliasesNormalized` while this entry is `applied`, and the key deduplication runs on. */
  @Prop({ type: String, required: true })
  aliasNormalized: string;

  @Prop({ type: String, required: true, enum: HARVESTED_ALIAS_STATUSES })
  status: HarvestedAliasStatus;

  /** Verbatim span of the document's text containing the definition, character-for-character, so
   *  an operator judging the alias reads the author's own sentence. */
  @Prop({ type: String, required: true })
  quote: string;

  /** Where {@link quote} sits in the document, to the precision the parser could address. */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  locator: EvidenceLocator;

  @Prop({ type: Types.ObjectId, ref: 'DocumentVersion', required: true })
  documentVersionId: Types.ObjectId;

  @Prop({ type: Date, required: true })
  harvestedAt: Date;
}

export const HarvestedAliasSchema = SchemaFactory.createForClass(HarvestedAlias);

/**
 * Entries `harvestedAliases` may hold on one row. Every entry carries a verbatim span of a
 * document, so this array is the only path by which document-derived text accumulates on a
 * `CanonicalEntity`; the cap and `MAX_HARVESTED_ENTRY_CHARACTERS` together hold the citation and
 * alias text one row persists under 142,000 characters, three orders of magnitude below the 16 MB
 * BSON document ceiling.
 *
 * `CanonicalEntityService.recordHarvestedAliases` enforces it at push time rather than a schema
 * validator enforcing it at save time, so a row already holding more entries than the cap still
 * accepts the save `revokeHarvestedAlias` makes to retire one.
 */
export const MAX_HARVESTED_ALIASES_PER_ENTITY = 200;

/**
 * NFKC-folds, trims, collapses internal whitespace runs to a single space, and lowercases — the
 * exact form stored in `canonicalNameNormalized`/`aliasesNormalized` (derived below by a
 * `pre('validate')` hook) and the form a lookup must produce from its own input to match them.
 * `CanonicalEntityService.resolve` is the sole read-path caller; a lookup that normalises a name
 * differently from how it was stored would silently miss it.
 *
 * The same function keys conflict grouping (`groupKey`, `detect-conflicts.ts`), so its answer
 * decides which facts are allowed to disagree with each other. NFKC comes first and does the
 * compatibility work a document's own encoding otherwise leaks into the key: a PDF text layer
 * emits fullwidth letters, non-breaking and figure spaces, and ligatures that name the same entity
 * a spreadsheet names in ASCII. Whitespace collapse then runs over `\s`, which covers every
 * `\p{Zs}` code point including the ones NFKC leaves alone (U+1680), so no run of spacing
 * characters can split one name into two keys.
 *
 * Deliberately compatibility folding and nothing more: it never strips punctuation, expands
 * abbreviations, or applies edit distance. Two names that differ by a real character are two
 * entities, matching the exact, alias-only discipline the registry below documents.
 */
export function normalizeEntityName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
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

  /** Every alias this row currently resolves by, normalised via {@link normalizeEntityName}: each
   * entry of `aliases`, plus each `harvestedAliases` entry whose status is `applied`. Same role and
   * same derivation as `canonicalNameNormalized` — the `pre('validate')` hook below owns it, and no
   * caller writes it directly. Folding applied harvested aliases in here rather than resolving them
   * separately is what keeps them inside `CanonicalEntityService.resolve`'s fail-closed ambiguity
   * branch: a harvested alias that also names another row leaves both unresolved, exactly as an
   * authored one does. */
  @Prop({ type: [String], default: [] })
  aliasesNormalized: string[];

  /** Aliases read out of documents by `harvestParentheticalAliases`, each with the quote and
   *  locator it was read from, never more than {@link MAX_HARVESTED_ALIASES_PER_ENTITY} of them.
   *  Only the `applied` entries affect resolution. */
  @Prop({ type: [HarvestedAliasSchema], default: [] })
  harvestedAliases: HarvestedAlias[];
}

export const CanonicalEntitySchema = SchemaFactory.createForClass(CanonicalEntity);

/**
 * Derives `canonicalNameNormalized`/`aliasesNormalized` from `canonicalName`, `aliases` and the
 * `applied` entries of `harvestedAliases` on every validate pass — `save()`/`create()` and any
 * other path that runs document validation — so the normalised fields can never drift out of sync
 * with the display fields they are computed from. Recomputing `aliasesNormalized` wholesale rather
 * than appending is what makes revocation take effect: an entry moved off `applied` is simply not
 * rebuilt, so the row stops resolving by it.
 * `pre('validate')` runs before the `required` path validators, so `canonicalNameNormalized`
 * still passes its own `required` check on a freshly constructed document. Does not fire on
 * `updateOne`/`findOneAndUpdate`-style updates (Mongoose only runs document middleware on
 * document `save()`) — `CanonicalEntityService.update` loads the document with `findOne` and
 * mutates it via `.save()` specifically so this hook still runs on a rename.
 */
CanonicalEntitySchema.pre('validate', function (this: CanonicalEntityDocument): void {
  this.canonicalNameNormalized = normalizeEntityName(this.canonicalName);
  this.aliasesNormalized = [
    ...new Set([
      ...this.aliases.map(normalizeEntityName),
      ...this.harvestedAliases
        .filter((harvested) => harvested.status === 'applied')
        .map((harvested) => harvested.aliasNormalized),
    ]),
  ];
});

/**
 * Declared here as well as in `migrations/0001-baseline.ts`, with the same keys, options
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

/** Backs `GET /canonical-entities?sort=createdAt` — the registry's default listing sorts
 *  `canonicalNameNormalized` instead, riding the unique index above. */
CanonicalEntitySchema.index(
  { tenantId: 1, createdAt: -1 },
  { name: 'canonical_entities_tenantId_createdAt' },
);
