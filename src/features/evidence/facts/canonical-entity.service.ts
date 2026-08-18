import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CanonicalEntity,
  CanonicalEntityDocument,
  normalizeEntityName,
} from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';

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
}
