import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  CanonicalEntity,
  CanonicalEntityDocument,
  type HarvestedAlias,
  type HarvestedAliasStatus,
  MAX_HARVESTED_ALIASES_PER_ENTITY,
  normalizeEntityName,
} from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  ExtractedFact,
  type ExtractedFactDocument,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import {
  CanonicalEntityNameConflictException,
  CanonicalEntityNotFoundException,
  HarvestedAliasAmbiguousException,
  HarvestedAliasNotFoundException,
  HarvestedAliasNotProposedException,
} from './exceptions/facts.exception';
import {
  type HarvestedAliasDefinition,
  MAX_HARVESTED_ALIAS_CHARACTERS,
  MAX_HARVESTED_QUOTE_CHARACTERS,
} from './harvest-parenthetical-aliases';
import { normalizeForNearMatch } from './near-match-entity-name';

/**
 * Characters one `harvestedAliases` entry's document-derived text may span — its citation plus the
 * alias cut out of it. Derived from the harvester's own two bounds rather than chosen again here,
 * so the gate at the point of persistence and the gate at the point of extraction cannot drift
 * apart.
 *
 * Enforced by {@link CanonicalEntityService.recordHarvestedAliases} against whatever it is handed,
 * not against what the harvester promises: a producer is the thing this gate exists to bound.
 */
export const MAX_HARVESTED_ENTRY_CHARACTERS =
  MAX_HARVESTED_QUOTE_CHARACTERS + MAX_HARVESTED_ALIAS_CHARACTERS;

/** Result of `CanonicalEntityService.resolve`. `matched` is the explicit "did this actually
 *  resolve" signal — `name` alone cannot carry that, since an unmatched input is returned
 *  unchanged and would otherwise be indistinguishable from a matched canonical name that happens
 *  to equal its own input. */
export interface CanonicalEntityResolution {
  readonly name: string;
  readonly matched: boolean;
}

/** One tenant's registered entity, as {@link CanonicalEntityService.listCanonicalEntities} returns
 *  it — the canonical display name plus both normalized forms a caller needs to match against
 *  free text without re-deriving `normalizeEntityName` itself. */
export interface CanonicalEntityListing {
  readonly canonicalName: string;
  readonly canonicalNameNormalized: string;
  readonly aliasesNormalized: readonly string[];
}

/** One tenant-authored row as the API returns it — `canonicalNameNormalized`/`aliasesNormalized`
 *  deliberately excluded, they are internal derivations `resolve`/`resolveMany` match against, not
 *  something a caller authors or reads back. Mapped to a plain result rather than a returned
 *  document for the same reason {@link CanonicalEntityListing}'s siblings across this codebase
 *  are — `toResponseDto` runs `plainToInstance` with `excludeExtraneousValues`, which reads own
 *  enumerable properties only, and a document's `id` is a virtual getter that a document handed
 *  straight to the DTO would silently serialise without (`MetricPolicyResult`'s doc comment). */
export interface CanonicalEntityResult {
  readonly id: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly harvestedAliases: readonly HarvestedAliasResult[];
  readonly createdAt: Date;
}

/** One document-harvested alias as the API returns it: the alias, whether it currently resolves,
 *  and the citation an operator judges it by. `aliasNormalized` is deliberately excluded for the
 *  same reason {@link CanonicalEntityResult} excludes the other normalized forms — it is an
 *  internal match key, not something a caller authors or reads back. */
export interface HarvestedAliasResult {
  readonly alias: string;
  readonly status: HarvestedAliasStatus;
  readonly quote: string;
  readonly locator: EvidenceLocator;
  readonly documentVersionId: string;
  readonly harvestedAt: Date;
}

function toCanonicalEntityResult(row: CanonicalEntityDocument): CanonicalEntityResult {
  return {
    id: row._id.toString(),
    canonicalName: row.canonicalName,
    aliases: row.aliases,
    harvestedAliases: row.harvestedAliases.map((harvested) => ({
      alias: harvested.alias,
      status: harvested.status,
      quote: harvested.quote,
      locator: harvested.locator,
      documentVersionId: harvested.documentVersionId.toString(),
      harvestedAt: harvested.harvestedAt,
    })),
    createdAt: row.createdAt,
  };
}

/**
 * Looks up a raw entity name (as read off a document) against the tenant's `CanonicalEntity`
 * registry and returns its canonical name when one is registered. Matching is exact and
 * alias-only — normalised (`normalizeEntityName`: trim, collapse internal whitespace, lowercase)
 * equality against a registry row's `canonicalNameNormalized` or one of its `aliasesNormalized`
 * entries — and **never** fuzzy or edit-distance. A name with no exact or alias match is returned
 * unchanged with `matched: false` so the caller can flag it for a human rather than this service
 * guessing at a match: a fuzzy matcher here would fabricate an agreement (or a conflict) between
 * two entities that were never actually the same, which is the one failure mode this registry
 * exists to prevent. The same reasoning covers an *ambiguous* match: `aliasesNormalized` carries a
 * non-unique index by design (0018-canonical-entities.ts), so a normalised name can legitimately
 * resolve to two different registry rows. When it does, both `resolve` and `resolveMany` return
 * the input unchanged with `matched: false` rather than picking either row — the same silent
 * guess this service exists to refuse, just arriving from the registry side instead of a fuzzy
 * matcher.
 */
@Injectable()
export class CanonicalEntityService {
  constructor(
    @InjectModel(CanonicalEntity.name)
    private readonly canonicalEntityModel: Model<CanonicalEntityDocument>,

    // Read-only here: `scanNearMatches` reads `entityMatched: false` facts as candidates, never
    // writes one. `FactsModule` already registers this schema for `FactsService`'s own use.
    @InjectModel(ExtractedFact.name)
    private readonly extractedFactModel: Model<ExtractedFactDocument>,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(CanonicalEntityService.name);
  }

  /** Tenant-scoped explicitly on every query. `tenantScopePlugin` would also intersect the
   *  activity's ALS tenant here, but that plugin is the structural backstop, not the primary
   *  control — a query that depends on it is one refactor away from running unscoped. */
  async resolve(rawName: string, tenantId: string): Promise<CanonicalEntityResolution> {
    const normalized = normalizeEntityName(rawName);

    const matches = await this.canonicalEntityModel.find({
      tenantId,
      $or: [{ canonicalNameNormalized: normalized }, { aliasesNormalized: normalized }],
    });

    const canonicalNames = new Set(matches.map((match) => match.canonicalName));

    if (canonicalNames.size === 0) {
      this.logger.debug(`No canonical entity registered for '${rawName}' in tenant '${tenantId}'`);
      return { name: rawName, matched: false };
    }

    if (canonicalNames.size > 1) {
      // Fails CLOSED: `aliasesNormalized` is deliberately non-unique (0018-canonical-entities.ts),
      // so the same normalized text can legitimately be registered under two different canonical
      // rows. Picking either one here would fabricate an agreement (or a conflict) between two
      // entities the registry never actually said were the same — exactly what this service's own
      // doc comment says it must never do — so an ambiguous match is left unresolved for a human.
      this.logger.warn(
        `'${rawName}' normalizes to '${normalized}', which resolves to ${canonicalNames.size} distinct canonical names in tenant '${tenantId}'; leaving unresolved`,
      );
      return { name: rawName, matched: false };
    }

    return { name: matches[0].canonicalName, matched: true };
  }

  /**
   * Batched counterpart to {@link resolve}: one query for however many names are given, rather
   * than one query per name. Fact extraction hands this every candidate's raw entity name in a
   * single call, so a document with many facts costs this service one round trip, not one per
   * fact. Returns one resolution per `rawNames` entry, in the same order and at the same
   * length — including duplicates — so a caller can zip the result back against its own input by
   * index, the same convention `mapWithConcurrency` callers in this feature already rely on.
   */
  async resolveMany(
    rawNames: readonly string[],
    tenantId: string,
  ): Promise<CanonicalEntityResolution[]> {
    if (rawNames.length === 0) {
      return [];
    }

    const normalizedNames = rawNames.map((rawName) => normalizeEntityName(rawName));
    const uniqueNormalizedNames = [...new Set(normalizedNames)];

    const matches = await this.canonicalEntityModel.find({
      tenantId,
      $or: [
        { canonicalNameNormalized: { $in: uniqueNormalizedNames } },
        { aliasesNormalized: { $in: uniqueNormalizedNames } },
      ],
    });

    // Set per normalized key, not a single last-write-wins map: the same normalized text can
    // legitimately resolve to more than one canonical row (`aliasesNormalized` is deliberately
    // non-unique — 0018-canonical-entities.ts), and collapsing that to whichever match the cursor
    // returned last would fabricate a resolution the registry never actually agreed on.
    const canonicalNamesByNormalized = new Map<string, Set<string>>();
    for (const match of matches) {
      for (const normalized of [match.canonicalNameNormalized, ...match.aliasesNormalized]) {
        const canonicalNames = canonicalNamesByNormalized.get(normalized) ?? new Set<string>();
        canonicalNames.add(match.canonicalName);
        canonicalNamesByNormalized.set(normalized, canonicalNames);
      }
    }

    return rawNames.map((rawName, index) => {
      const canonicalNames = canonicalNamesByNormalized.get(normalizedNames[index]);

      if (!canonicalNames || canonicalNames.size === 0) {
        this.logger.debug(
          `No canonical entity registered for '${rawName}' in tenant '${tenantId}'`,
        );
        return { name: rawName, matched: false };
      }

      if (canonicalNames.size > 1) {
        // Fails CLOSED — same reasoning as the ambiguity branch in `resolve`.
        this.logger.warn(
          `'${rawName}' normalizes to '${normalizedNames[index]}', which resolves to ${canonicalNames.size} distinct canonical names in tenant '${tenantId}'; leaving unresolved`,
        );
        return { name: rawName, matched: false };
      }

      const [canonicalName] = canonicalNames;
      return { name: canonicalName, matched: true };
    });
  }

  /** Every entity registered for `tenantId` — no name filter, unlike {@link resolve}/{@link
   *  resolveMany}, since a caller here needs the whole registry to match arbitrary free text (e.g.
   *  a question) against rather than looking up one known name. Tenant-scoped explicitly on the
   *  query for the same reason `resolve` is — `tenantScopePlugin` is a backstop, not the primary
   *  control.
   *
   *  Projected to the three fields {@link CanonicalEntityListing} carries, so `harvestedAliases`
   *  and the verbatim quotes it holds never cross the wire. This runs once per question
   *  (`activities.ts`'s `groundingCheck`) over the tenant's whole registry, and matching free text
   *  needs `aliasesNormalized`, not the provenance an operator reads. */
  async listCanonicalEntities(tenantId: string): Promise<CanonicalEntityListing[]> {
    const entities = await this.canonicalEntityModel.find(
      { tenantId },
      { canonicalName: 1, canonicalNameNormalized: 1, aliasesNormalized: 1 },
    );
    return entities.map((entity) => ({
      canonicalName: entity.canonicalName,
      canonicalNameNormalized: entity.canonicalNameNormalized,
      aliasesNormalized: entity.aliasesNormalized,
    }));
  }

  /** The tenant's authored rows, paginated — not {@link listCanonicalEntities}'s unpaginated,
   *  match-oriented projection. Sorted newest-first, matching `ApiKeysService.list`/
   *  `InvitationsService.list`'s identical paginated-listing shape. */
  async listForTenant(
    tenantId: string,
    pagination: PaginationRequestDto,
  ): Promise<DocumentResultWithCount<CanonicalEntityResult>> {
    const filter = { tenantId };

    const [rows, count] = await Promise.all([
      this.canonicalEntityModel.find(filter, null, {
        sort: { createdAt: -1 },
        skip: pagination.skip,
        limit: pagination.limit,
      }),
      this.canonicalEntityModel.countDocuments(filter),
    ]);

    return { docs: rows.map((row) => toCanonicalEntityResult(row)), count };
  }

  /** Maps the unique `{tenantId, canonicalNameNormalized}` index
   *  (`canonical-entity.schema.ts`) onto a 409 — the application-layer surface for a race the
   *  index itself already prevents at the driver level, the same pattern
   *  `SourcesService.create` uses for its own unique-name index. */
  async create(
    tenantId: string,
    input: { canonicalName: string; aliases?: string[] },
    actorId: string,
  ): Promise<CanonicalEntityResult> {
    let entity: CanonicalEntityDocument;
    try {
      entity = await this.canonicalEntityModel.create({
        tenantId,
        canonicalName: input.canonicalName,
        aliases: input.aliases ?? [],
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new CanonicalEntityNameConflictException(
          `A canonical entity named '${input.canonicalName}' already exists for this tenant`,
          error,
        );
      }
      throw error;
    }

    await this.auditService.record({
      action: 'canonical-entities.created',
      actorId,
      subject: { entityType: 'CanonicalEntity', entityId: entity._id.toString() },
      tenantId,
    });

    this.logger.debug(
      `Created canonical entity '${entity._id.toString()}' for tenant '${tenantId}'`,
    );

    return toCanonicalEntityResult(entity);
  }

  /**
   * Loaded with `findOne` and mutated via `.save()`, not `findOneAndUpdate`: this schema's
   * `pre('validate')` hook derives `canonicalNameNormalized`/`aliasesNormalized` from
   * `canonicalName`/`aliases`, and that document middleware only fires on the document-level save
   * path (`DocumentsService.addVersion`/`AnswerPersistenceService.persist` use the same
   * findOne-then-mutate-then-save shape for the same reason). A `findOneAndUpdate` here would
   * write new display fields while leaving the normalized fields stale — since every lookup in
   * this service matches on the normalized fields, a renamed row would silently stop resolving.
   * Renaming does not retroactively regroup facts already extracted under the old canonical name —
   * `ExtractedFact.groupKeyNormalized` was computed at extraction time and stays as it was.
   */
  async update(
    id: string,
    tenantId: string,
    updates: { canonicalName?: string; aliases?: string[] },
    actorId: string,
  ): Promise<CanonicalEntityResult> {
    if (!Types.ObjectId.isValid(id)) {
      throw new CanonicalEntityNotFoundException(`Canonical entity '${id}' not found`);
    }

    const entity = await this.canonicalEntityModel.findOne({ _id: id, tenantId });
    if (!entity) {
      throw new CanonicalEntityNotFoundException(`Canonical entity '${id}' not found`);
    }

    if (updates.canonicalName !== undefined) {
      entity.canonicalName = updates.canonicalName;
    }
    if (updates.aliases !== undefined) {
      entity.aliases = updates.aliases;
    }

    try {
      await entity.save();
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new CanonicalEntityNameConflictException(
          `A canonical entity named '${entity.canonicalName}' already exists for this tenant`,
          error,
        );
      }
      throw error;
    }

    await this.auditService.record({
      action: 'canonical-entities.updated',
      actorId,
      subject: { entityType: 'CanonicalEntity', entityId: id },
      tenantId,
    });

    this.logger.debug(`Updated canonical entity '${id}' for tenant '${tenantId}'`);

    return toCanonicalEntityResult(entity);
  }

  /** Deleting a row does not retroactively regroup facts already extracted under its
   *  `groupKeyNormalized` — that key was computed at extraction time, so a fact extracted while
   *  this row resolved its entity keeps grouping under the name that was canonical then. */
  async remove(id: string, tenantId: string, actorId: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      throw new CanonicalEntityNotFoundException(`Canonical entity '${id}' not found`);
    }

    const entity = await this.canonicalEntityModel.findOneAndDelete({ _id: id, tenantId });
    if (!entity) {
      throw new CanonicalEntityNotFoundException(`Canonical entity '${id}' not found`);
    }

    await this.auditService.record({
      action: 'canonical-entities.removed',
      actorId,
      subject: { entityType: 'CanonicalEntity', entityId: id },
      tenantId,
    });

    this.logger.debug(`Removed canonical entity '${id}' from tenant '${tenantId}'`);
  }

  /**
   * Files parenthetical definitions read out of a document version against the tenant's registry,
   * one entry per alias on the row whose entity the definition's antecedent names.
   *
   * `autoApply` decides only the status the entry lands in — `applied` (folded into
   * `aliasesNormalized` by the schema hook, so it resolves) or `proposed` (recorded with its
   * citation, resolving nothing). Nothing else about this method's behaviour depends on it: the
   * same rows are read, the same entries are written, and an operator sees the same proposals
   * either way.
   *
   * Registers nothing it cannot attribute. A definition whose antecedent matches no registered
   * entity is dropped, and one whose antecedent matches two different registry rows is dropped
   * rather than assigned to either — the same fail-closed refusal {@link resolve} makes on an
   * ambiguous lookup, applied at the point the alias is written instead of the point it is read.
   * An alias already present on the row — as its canonical name, an authored alias, or a
   * harvested entry in any status — is left exactly as it stands, which is what makes revocation
   * durable: re-ingesting the document that defined it does not resurrect a revoked entry.
   *
   * Bounded at both ends of what it writes, and refusing rather than clipping in both cases: an
   * entry whose citation plus alias spans more than {@link MAX_HARVESTED_ENTRY_CHARACTERS} is not
   * written, and a row already holding `MAX_HARVESTED_ALIASES_PER_ENTITY` entries takes no more.
   *
   * Returns the number of entries written, for the caller's log.
   */
  async recordHarvestedAliases(
    definitions: readonly HarvestedAliasDefinition[],
    tenantId: string,
    documentVersionId: Types.ObjectId,
    autoApply: boolean,
  ): Promise<number> {
    if (definitions.length === 0) {
      return 0;
    }

    const subjectNames = [
      ...new Set(
        definitions.flatMap((definition) =>
          definition.subjectCandidates.map((candidate) => normalizeEntityName(candidate.name)),
        ),
      ),
    ];

    const rows = await this.canonicalEntityModel.find({
      tenantId,
      $or: [
        { canonicalNameNormalized: { $in: subjectNames } },
        { aliasesNormalized: { $in: subjectNames } },
      ],
    });

    const rowsByName = new Map<string, CanonicalEntityDocument[]>();
    for (const row of rows) {
      for (const name of [row.canonicalNameNormalized, ...row.aliasesNormalized]) {
        rowsByName.set(name, [...(rowsByName.get(name) ?? []), row]);
      }
    }

    const status: HarvestedAliasStatus = autoApply ? 'applied' : 'proposed';
    const harvestedAt = new Date();
    const touched = new Set<CanonicalEntityDocument>();
    let recorded = 0;

    for (const definition of definitions) {
      const subject = this.resolveHarvestSubject(definition, rowsByName, tenantId);
      if (!subject) {
        continue;
      }

      const { row, quote } = subject;

      for (const alias of definition.aliases) {
        const aliasNormalized = normalizeEntityName(alias);
        const written = this.tryPushHarvestedEntry(row, {
          alias,
          aliasNormalized,
          status,
          quote,
          locator: definition.locator,
          documentVersionId,
          harvestedAt,
        });
        if (written) {
          touched.add(row);
          recorded += 1;
        }
      }
    }

    // `.save()` on the loaded document, never `updateOne`/`$push`: `aliasesNormalized` is derived
    // by this schema's `pre('validate')` hook, which Mongoose runs only on the document save path.
    // A pushed entry would leave the normalized field stale, so an `applied` alias would resolve
    // nothing — the same trap `update` documents.
    for (const row of touched) {
      await row.save();
    }

    return recorded;
  }

  /**
   * The registry row a definition's antecedent names and the citation cut at that antecedent, or
   * `null` when there is no single answer.
   *
   * Candidates are tried longest first, so the most specific phrase that is actually a registered
   * entity wins — "Northgate Business Park" over "Business Park" when both are registered as
   * separate entities. The first candidate that matches anything decides the outcome, including
   * deciding against attribution: if it matches two different rows, this returns `null` rather
   * than falling through to a shorter, less specific candidate, because a shorter suffix agreeing
   * where the specific one was ambiguous is exactly the guess this registry refuses to make.
   *
   * The quote travels back with the row because it belongs to the candidate that matched, not to
   * the definition: an operator judging the proposal reads a citation whose leading text is the
   * antecedent the alias was actually attributed to.
   */
  private resolveHarvestSubject(
    definition: HarvestedAliasDefinition,
    rowsByName: ReadonlyMap<string, CanonicalEntityDocument[]>,
    tenantId: string,
  ): { readonly row: CanonicalEntityDocument; readonly quote: string } | null {
    for (const candidate of definition.subjectCandidates) {
      const matches = rowsByName.get(normalizeEntityName(candidate.name));
      if (!matches) {
        continue;
      }

      const distinctRowIds = new Set(matches.map((row) => row._id.toString()));
      if (distinctRowIds.size > 1) {
        // Fails CLOSED — same reasoning as the ambiguity branch in `resolve`. Attaching the alias
        // to either row would fabricate a link between two entities the registry never said were
        // the same, and would do it tenant-wide and permanently.
        this.logger.warn(
          `Antecedent '${candidate.name}' of harvested alias '${definition.aliases[0]}' matches ${distinctRowIds.size} distinct canonical entities in tenant '${tenantId}'; recording nothing`,
        );
        return null;
      }

      return { row: matches[0], quote: candidate.quote };
    }

    this.logger.debug(
      `No canonical entity registered for the antecedent of harvested alias '${definition.aliases[0]}' in tenant '${tenantId}'`,
    );
    return null;
  }

  /**
   * Pushes one `harvestedAliases` entry onto `row` if it fits both bounds
   * {@link recordHarvestedAliases}'s own doc comment states, and is not already on the row in any
   * capacity — its canonical name, an authored alias, or a harvested entry in any status. Shared by
   * {@link recordHarvestedAliases} and {@link scanNearMatches}: a document-read alias and an
   * inferred one are written through the same gate, so neither source can grow a row past the other
   * source's bound. Returns whether the entry was written, so a caller can count what it recorded.
   */
  private tryPushHarvestedEntry(row: CanonicalEntityDocument, entry: HarvestedAlias): boolean {
    if (
      entry.aliasNormalized === row.canonicalNameNormalized ||
      row.aliases.some((existing) => normalizeEntityName(existing) === entry.aliasNormalized) ||
      row.harvestedAliases.some((existing) => existing.aliasNormalized === entry.aliasNormalized)
    ) {
      return false;
    }

    // Both gates fail CLOSED — the entry is not written, and nothing is clipped to make it fit.
    // This is the point of persistence for every byte of document text that reaches a
    // `CanonicalEntity`, and neither a parser nor a fact's own `rawText` bounds what it may hold,
    // so an unbounded entry here is an unbounded row and eventually a row that exceeds the BSON
    // document ceiling and can no longer be saved at all.
    if (entry.alias.length + entry.quote.length > MAX_HARVESTED_ENTRY_CHARACTERS) {
      this.logger.warn(
        `Harvested alias '${entry.aliasNormalized}' for canonical entity '${row._id.toString()}' spans ${entry.alias.length + entry.quote.length} characters, over the ${MAX_HARVESTED_ENTRY_CHARACTERS}-character entry budget; recording nothing`,
      );
      return false;
    }

    if (row.harvestedAliases.length >= MAX_HARVESTED_ALIASES_PER_ENTITY) {
      this.logger.warn(
        `Canonical entity '${row._id.toString()}' already holds ${MAX_HARVESTED_ALIASES_PER_ENTITY} harvested aliases; recording nothing for '${entry.aliasNormalized}'`,
      );
      return false;
    }

    row.harvestedAliases.push(entry);
    return true;
  }

  /**
   * Proposes an alias for every unresolved fact entity name (`ExtractedFact.entityMatched: false`)
   * that is a suffix-only or punctuation-only near match of a row already registered — never an
   * exact match, which would already resolve and so never carries `entityMatched: false` in the
   * first place. Persisted as a `proposed` `harvestedAliases` entry, exactly like a document-read
   * alias, with the fact's own raw text standing in for the quote: **evidence applies, inference
   * proposes**, so a near match can reach `proposed` here but never `applied` — only {@link
   * applyHarvestedAlias} can do that, and only on an operator's own instruction.
   *
   * `entityMatched` is a point-in-time flag from extraction, not re-derived here, so a candidate
   * whose *exact* normalized form now resolves against the registry (grown since extraction) is
   * skipped before the near-match comparison — proposing it would risk landing the same alias on a
   * second row by inference, undermining the exact match the registry already has.
   *
   * A candidate that near-matches more than one registered row is attributed to neither — the same
   * fail-closed refusal {@link resolveHarvestSubject} makes on an ambiguous antecedent, applied to
   * an inferred match instead of a read one.
   *
   * Not audited per proposal, the same as {@link recordHarvestedAliases}: proposing changes nothing
   * a caller can act on by itself, and the operator decision this queue exists for is audited at
   * {@link applyHarvestedAlias}/{@link revokeHarvestedAlias} instead. Returns the number of entries
   * written, for the caller's response.
   */
  async scanNearMatches(tenantId: string): Promise<number> {
    const rows = await this.canonicalEntityModel.find({ tenantId });
    if (rows.length === 0) {
      return 0;
    }

    const registeredNormalized = new Set<string>();
    const rowsByNearMatch = new Map<string, CanonicalEntityDocument[]>();
    for (const row of rows) {
      for (const name of [row.canonicalNameNormalized, ...row.aliasesNormalized]) {
        registeredNormalized.add(name);

        const nearMatchKey = normalizeForNearMatch(name);
        if (nearMatchKey.length === 0) {
          continue;
        }
        rowsByNearMatch.set(nearMatchKey, [...(rowsByNearMatch.get(nearMatchKey) ?? []), row]);
      }
    }

    const candidates = await this.extractedFactModel.find(
      { tenantId, entityMatched: false },
      { factKey: 1, rawText: 1, locator: 1, documentVersionId: 1 },
      { sort: { createdAt: -1 } },
    );

    // Deduplicated by normalized entity name, keeping the most recently extracted fact as the
    // proposal's citation — `candidates` is already sorted newest first, so the first occurrence
    // of a normalized name is that name's latest mention.
    const candidatesByNormalized = new Map<string, ExtractedFactDocument>();
    for (const candidate of candidates) {
      const candidateNormalized = normalizeEntityName(candidate.factKey.entity);
      if (!candidatesByNormalized.has(candidateNormalized)) {
        candidatesByNormalized.set(candidateNormalized, candidate);
      }
    }

    const harvestedAt = new Date();
    const touched = new Set<CanonicalEntityDocument>();
    let recorded = 0;

    for (const [candidateNormalized, candidate] of candidatesByNormalized) {
      if (registeredNormalized.has(candidateNormalized)) {
        continue;
      }

      const nearMatchKey = normalizeForNearMatch(candidate.factKey.entity);
      if (nearMatchKey.length === 0) {
        continue;
      }

      const matches = rowsByNearMatch.get(nearMatchKey);
      if (!matches) {
        continue;
      }

      const distinctRows = [...new Map(matches.map((row) => [row._id.toString(), row])).values()];
      if (distinctRows.length > 1) {
        // Fails CLOSED — same reasoning as the ambiguity branch in `resolveHarvestSubject`.
        // Attributing an inferred match to either row would fabricate a link between two entities
        // the registry never said were the same.
        this.logger.warn(
          `Near match '${candidate.factKey.entity}' matches ${distinctRows.length} distinct canonical entities in tenant '${tenantId}'; recording nothing`,
        );
        continue;
      }

      const [row] = distinctRows;
      const written = this.tryPushHarvestedEntry(row, {
        alias: candidate.factKey.entity,
        aliasNormalized: candidateNormalized,
        status: 'proposed',
        quote: candidate.rawText,
        locator: candidate.locator,
        documentVersionId: candidate.documentVersionId,
        harvestedAt,
      });
      if (written) {
        touched.add(row);
        recorded += 1;
      }
    }

    for (const row of touched) {
      await row.save();
    }

    return recorded;
  }

  /**
   * Marks a harvested alias rejected. Terminal by design: {@link recordHarvestedAliases} skips an
   * alias already present in any status, so re-ingesting the document that defined it leaves the
   * revocation standing. The schema's `pre('validate')` hook rebuilds `aliasesNormalized` from the
   * `applied` entries only, so the row stops resolving by this alias the moment the save lands.
   *
   * Loaded with `findOne` and mutated via `.save()` for the reason {@link update} documents — this
   * is the write whose whole effect is the hook's re-derivation.
   */
  async revokeHarvestedAlias(
    id: string,
    tenantId: string,
    alias: string,
    actorId: string,
  ): Promise<CanonicalEntityResult> {
    if (!Types.ObjectId.isValid(id)) {
      throw new CanonicalEntityNotFoundException(`Canonical entity '${id}' not found`);
    }

    const entity = await this.canonicalEntityModel.findOne({ _id: id, tenantId });
    if (!entity) {
      throw new CanonicalEntityNotFoundException(`Canonical entity '${id}' not found`);
    }

    const aliasNormalized = normalizeEntityName(alias);
    const harvested = entity.harvestedAliases.find(
      (candidate) => candidate.aliasNormalized === aliasNormalized,
    );
    if (!harvested) {
      throw new HarvestedAliasNotFoundException(
        `Canonical entity '${id}' has no harvested alias '${alias}'`,
      );
    }

    harvested.status = 'revoked';
    await entity.save();

    await this.auditService.record({
      action: 'canonical-entities.harvested-alias-revoked',
      actorId,
      subject: { entityType: 'CanonicalEntity', entityId: id },
      tenantId,
    });

    this.logger.debug(
      `Revoked harvested alias '${alias}' on canonical entity '${id}' for tenant '${tenantId}'`,
    );

    return toCanonicalEntityResult(entity);
  }

  /**
   * Marks a `proposed` harvested alias `applied`, folding it into `aliasesNormalized` on save so it
   * resolves exactly as an operator-authored alias does — the one-click confirmation half of
   * "evidence applies, inference proposes": nothing in this service writes `applied` on its own
   * initiative for either a harvested or a near-match entry, only in answer to this call.
   *
   * Refuses any status but `proposed`: `revoked` is documented terminal ({@link
   * revokeHarvestedAlias}), and applying it here would silently un-terminate an operator's own
   * rejection; an already-`applied` entry has nothing left for this call to do. Also refuses when
   * the alias now also names a *different* registered row — the registry can grow between a
   * proposal being raised and an operator confirming it, and applying into a name that has become
   * ambiguous would land an alias `resolve`'s own ambiguity branch immediately refuses to serve.
   * Every one of these fails CLOSED — the row is left exactly as it stands — rather than treated as
   * a no-op success that would let a caller believe it changed something it did not.
   *
   * Loaded with `findOne` and mutated via `.save()` for the reason {@link update} documents — this
   * is the write whose whole effect is the hook's re-derivation.
   */
  async applyHarvestedAlias(
    id: string,
    tenantId: string,
    alias: string,
    actorId: string,
  ): Promise<CanonicalEntityResult> {
    if (!Types.ObjectId.isValid(id)) {
      throw new CanonicalEntityNotFoundException(`Canonical entity '${id}' not found`);
    }

    const entity = await this.canonicalEntityModel.findOne({ _id: id, tenantId });
    if (!entity) {
      throw new CanonicalEntityNotFoundException(`Canonical entity '${id}' not found`);
    }

    const aliasNormalized = normalizeEntityName(alias);
    const harvested = entity.harvestedAliases.find(
      (candidate) => candidate.aliasNormalized === aliasNormalized,
    );
    if (!harvested) {
      throw new HarvestedAliasNotFoundException(
        `Canonical entity '${id}' has no harvested alias '${alias}'`,
      );
    }

    if (harvested.status !== 'proposed') {
      throw new HarvestedAliasNotProposedException(
        `Harvested alias '${alias}' on canonical entity '${id}' is '${harvested.status}', not 'proposed'`,
      );
    }

    // Re-checked here, not trusted from proposal time: the registry can grow between a proposal
    // being raised and an operator confirming it, and applying into a now-ambiguous name would
    // land an alias that `resolve`'s own ambiguity branch immediately refuses to serve — a
    // confirmation that silently does nothing useful instead of failing where the operator can see
    // it. Fails CLOSED, the same direction every other ambiguity branch in this service takes.
    const conflictingRow = await this.canonicalEntityModel.findOne({
      tenantId,
      _id: { $ne: entity._id },
      $or: [{ canonicalNameNormalized: aliasNormalized }, { aliasesNormalized: aliasNormalized }],
    });
    if (conflictingRow) {
      throw new HarvestedAliasAmbiguousException(
        `Harvested alias '${alias}' on canonical entity '${id}' now also names canonical entity '${conflictingRow._id.toString()}'; applying it would resolve to neither`,
      );
    }

    harvested.status = 'applied';
    await entity.save();

    await this.auditService.record({
      action: 'canonical-entities.harvested-alias-applied',
      actorId,
      subject: { entityType: 'CanonicalEntity', entityId: id },
      tenantId,
    });

    this.logger.debug(
      `Applied harvested alias '${alias}' on canonical entity '${id}' for tenant '${tenantId}'`,
    );

    return toCanonicalEntityResult(entity);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
