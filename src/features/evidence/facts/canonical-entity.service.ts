import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  CanonicalEntity,
  CanonicalEntityDocument,
  normalizeEntityName,
} from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import {
  CanonicalEntityNameConflictException,
  CanonicalEntityNotFoundException,
} from './exceptions/facts.exception';

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
  readonly createdAt: Date;
}

function toCanonicalEntityResult(row: CanonicalEntityDocument): CanonicalEntityResult {
  return {
    id: row._id.toString(),
    canonicalName: row.canonicalName,
    aliases: row.aliases,
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
   *  control. */
  async listCanonicalEntities(tenantId: string): Promise<CanonicalEntityListing[]> {
    const entities = await this.canonicalEntityModel.find({ tenantId });
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

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
