import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { DocumentSourceClass } from '../../../database/schemas/evidence/document/document.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  MAX_PROPOSED_FROM_PER_MEASURE,
  Measure,
  MeasureDocument,
  type MeasureStatus,
  type MeasureUnit,
} from '../../../database/schemas/evidence/measure/measure.schema';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import {
  DEFAULT_PAGINATION_LIMIT,
  DEFAULT_PAGINATION_SKIP,
} from '../../../shared/constants/pagination-defaults.constant';
import type { SortDirection } from '../../../shared/constants/sort.constant';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import { ConflictsService } from '../conflicts/conflicts.service';
import type { FactValueType, ToleranceKind } from '../facts/metric-ontology';
import type { HeaderMeasureProposal } from './infer-header-measure';
import {
  orderForExtraction,
  toMeasureDefinitions,
  validateMeasureDefinition,
  type MeasureDefinition,
  type MeasureStamp,
} from './measure-definition';
import {
  MeasureNotConfirmedException,
  MeasureNotFoundException,
  MeasureNotProposedException,
} from './exceptions/measures.exception';

/**
 * `MeasuresController` (added once the request DTO exists) satisfies this with
 * `ListMeasuresRequestDto` — the same `status`/`sort`/`sortDir`/`skip`/`limit` shape
 * `ListConflictsRequestDto` already establishes for the sibling `conflicts` list endpoint.
 */
export interface ListMeasuresParams {
  readonly status?: MeasureStatus;
  readonly sort?: string;
  readonly sortDir?: SortDirection;
  readonly skip?: number;
  readonly limit?: number;
}

export interface ExtractionMeasureContext {
  readonly confirmed: readonly MeasureDefinition[];
  readonly matchable: readonly MeasureDefinition[];
  readonly rejectedSlugs: ReadonlySet<string>;
}

export interface MeasureEdits {
  label?: string;
  aliases?: string[];
  valueType?: FactValueType;
  canonicalUnit?: string;
  units?: MeasureUnit[];
  toleranceKind?: ToleranceKind;
  tolerance?: number;
  authorityOrder?: DocumentSourceClass[];
  stalenessWindowMs?: number;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

@Injectable()
export class MeasuresService {
  constructor(
    @InjectModel(Measure.name)
    private readonly measureModel: Model<MeasureDocument>,

    @InjectModel(ExtractedFact.name)
    private readonly extractedFactModel: Model<ExtractedFactDocument>,

    private readonly conflictsService: ConflictsService,
    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(MeasuresService.name);
  }

  async listForTenant(
    tenantId: string,
    dto: ListMeasuresParams,
  ): Promise<DocumentResultWithCount<MeasureDocument>> {
    const filter = { tenantId, ...(dto.status ? { status: dto.status } : {}) };

    const [docs, count] = await Promise.all([
      this.measureModel.find(filter, null, {
        sort: resolveSort(dto.sort, dto.sortDir, 'createdAt', 'desc'),
        skip: dto.skip ?? DEFAULT_PAGINATION_SKIP,
        limit: dto.limit ?? DEFAULT_PAGINATION_LIMIT,
      }),
      this.measureModel.countDocuments(filter),
    ]);

    return { docs, count };
  }

  /** Every `'confirmed'` measure, ordered the way the prose extractor's system prompt and
   * `z.enum` schema need it (`orderForExtraction`) — the allowlist a tenant's extraction runs
   * against. */
  async listConfirmedDefinitions(tenantId: string): Promise<MeasureDefinition[]> {
    const docs = await this.measureModel.find({ tenantId, status: 'confirmed' });
    return orderForExtraction(toMeasureDefinitions(docs));
  }

  /** One `find` covering every status a fact extraction pass needs to know about: `confirmed`
   * (the ordered allowlist), `proposed` (matchable, so a document that repeats an already-proposed
   * header does not mint a second measure for it), and `rejected` (excluded outright — a rejected
   * slug proposes nothing, ever, until a human reverses that by other means). */
  async loadExtractionContext(tenantId: string): Promise<ExtractionMeasureContext> {
    const docs = await this.measureModel.find({
      tenantId,
      status: { $in: ['confirmed', 'proposed', 'rejected'] },
    });

    const confirmed = orderForExtraction(
      toMeasureDefinitions(docs.filter((doc) => doc.status === 'confirmed')),
    );
    const proposed = toMeasureDefinitions(docs.filter((doc) => doc.status === 'proposed'));
    const rejectedSlugs = new Set(
      docs.filter((doc) => doc.status === 'rejected').map((doc) => doc.slug),
    );

    return { confirmed, matchable: [...confirmed, ...proposed], rejectedSlugs };
  }

  /** Any status — the queue view (`GET /measures`) and `proposeMany` both need to see a
   * `'rejected'` row too, not just a `'confirmed'`/`'proposed'` one. */
  async findBySlug(slug: string, tenantId: string): Promise<MeasureDocument | null> {
    return this.measureModel.findOne({ tenantId, slug });
  }

  /**
   * Mints a `MeasureStamp` for every proposal a fact extraction pass can safely stamp a candidate
   * under, and nothing for the rest. Fails CLOSED per column: a slug that resolves to a
   * `'rejected'` row, or that this call cannot resolve to any row at all, is simply absent from the
   * returned map — the caller (`FactsService`) must treat an absent stamp as "mint no fact for this
   * candidate," never fall back to an unstamped write, because that would persist a fact under a
   * measure the tenant does not (or no longer) hold.
   *
   * Two tenants' concurrent ingests can race the same never-seen slug onto the unique
   * `{tenantId, slug}` index at once; the loser's `create` throws a duplicate-key error (`code
   * === 11000`), which this method catches and turns into a fresh `findOne` — the same
   * existing-row branches below then decide the loser's stamp exactly as if it had found the row
   * on its first read.
   */
  async proposeMany(
    tenantId: string,
    documentVersionId: Types.ObjectId,
    proposals: readonly HeaderMeasureProposal[],
  ): Promise<Map<string, MeasureStamp>> {
    const stamps = new Map<string, MeasureStamp>();

    for (const proposal of proposals) {
      const stamp = await this.proposeOne(tenantId, documentVersionId, proposal);
      if (stamp) {
        stamps.set(proposal.slug, stamp);
      }
    }

    return stamps;
  }

  private async proposeOne(
    tenantId: string,
    documentVersionId: Types.ObjectId,
    proposal: HeaderMeasureProposal,
  ): Promise<MeasureStamp | undefined> {
    const existing = await this.measureModel.findOne({ tenantId, slug: proposal.slug });
    if (existing) {
      return this.stampExisting(existing, documentVersionId, proposal);
    }

    try {
      const created = await this.measureModel.create({
        tenantId,
        slug: proposal.slug,
        label: proposal.label,
        aliases: proposal.aliases,
        valueType: proposal.valueType,
        canonicalUnit: proposal.canonicalUnit,
        units: [...proposal.units],
        toleranceKind: proposal.toleranceKind,
        tolerance: proposal.tolerance,
        status: 'proposed',
        origin: 'header',
        version: 1,
        proposedFrom: [
          { documentVersionId, locator: proposal.headerLocator, headerText: proposal.headerText },
        ],
      });
      return { measureId: created._id, measureVersion: created.version, measureStatus: 'proposed' };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      const raced = await this.measureModel.findOne({ tenantId, slug: proposal.slug });
      return raced ? this.stampExisting(raced, documentVersionId, proposal) : undefined;
    }
  }

  private async stampExisting(
    doc: MeasureDocument,
    documentVersionId: Types.ObjectId,
    proposal: HeaderMeasureProposal,
  ): Promise<MeasureStamp | undefined> {
    if (doc.status === 'rejected') {
      return undefined;
    }

    if (doc.status === 'confirmed') {
      return { measureId: doc._id, measureVersion: doc.version, measureStatus: 'confirmed' };
    }

    const alreadyRecorded = doc.proposedFrom.some((evidence) =>
      evidence.documentVersionId.equals(documentVersionId),
    );
    if (!alreadyRecorded && doc.proposedFrom.length < MAX_PROPOSED_FROM_PER_MEASURE) {
      doc.proposedFrom.push({
        documentVersionId,
        locator: proposal.headerLocator,
        headerText: proposal.headerText,
      });
      await doc.save();
    }

    return { measureId: doc._id, measureVersion: doc.version, measureStatus: 'proposed' };
  }

  /**
   * Confirms a `'proposed'` measure: merges `edits` over the current definition, validates the
   * merged result, bumps `version`, then rescans the groups its now-visible facts belong to
   * (`runRescan`). A human's decision to confirm is not hostage to that rescan — see `runRescan`'s
   * own doc comment for the full fail-OPEN statement.
   */
  async confirm(
    id: string,
    tenantId: string,
    edits: MeasureEdits,
    actorId: string,
  ): Promise<MeasureDocument> {
    const doc = await this.loadById(id, tenantId);
    if (doc.status !== 'proposed') {
      throw new MeasureNotProposedException(`Measure '${id}' is '${doc.status}', not 'proposed'`);
    }

    this.applyEdits(doc, edits);
    validateMeasureDefinition(doc);
    doc.status = 'confirmed';
    doc.version += 1;
    doc.confirmedBy = actorId;
    doc.confirmedAt = new Date();
    await doc.save();

    await this.runRescan(doc, tenantId);

    await this.auditService.record({
      action: 'measures.confirmed',
      actorId,
      subject: { entityType: 'Measure', entityId: doc._id.toString() },
      tenantId,
    });

    return doc;
  }

  async reject(
    id: string,
    tenantId: string,
    reason: string | undefined,
    actorId: string,
  ): Promise<MeasureDocument> {
    const doc = await this.loadById(id, tenantId);
    if (doc.status !== 'proposed') {
      throw new MeasureNotProposedException(`Measure '${id}' is '${doc.status}', not 'proposed'`);
    }

    doc.status = 'rejected';
    doc.rejectedBy = actorId;
    doc.rejectedAt = new Date();
    doc.rejectedReason = reason;
    await doc.save();

    await this.auditService.record({
      action: 'measures.rejected',
      actorId,
      subject: { entityType: 'Measure', entityId: doc._id.toString() },
      tenantId,
    });

    return doc;
  }

  /** Edits a `'confirmed'` measure in place — the same merge/validate/version-bump/rescan tail
   * `confirm` runs, minus the status transition, because a `'proposed'` or `'rejected'` row has no
   * confirmed facts yet to rescan. */
  async update(
    id: string,
    tenantId: string,
    edits: MeasureEdits,
    actorId: string,
  ): Promise<MeasureDocument> {
    const doc = await this.loadById(id, tenantId);
    if (doc.status !== 'confirmed') {
      throw new MeasureNotConfirmedException(`Measure '${id}' is '${doc.status}', not 'confirmed'`);
    }

    this.applyEdits(doc, edits);
    validateMeasureDefinition(doc);
    doc.version += 1;
    await doc.save();

    await this.runRescan(doc, tenantId);

    await this.auditService.record({
      action: 'measures.updated',
      actorId,
      subject: { entityType: 'Measure', entityId: doc._id.toString() },
      tenantId,
    });

    return doc;
  }

  private async loadById(id: string, tenantId: string): Promise<MeasureDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new MeasureNotFoundException(`Measure '${id}' not found`);
    }
    const doc = await this.measureModel.findOne({ _id: id, tenantId });
    if (!doc) {
      throw new MeasureNotFoundException(`Measure '${id}' not found`);
    }
    return doc;
  }

  private applyEdits(doc: MeasureDocument, edits: MeasureEdits): void {
    if (edits.label !== undefined) doc.label = edits.label;
    if (edits.aliases !== undefined) doc.aliases = edits.aliases;
    if (edits.valueType !== undefined) doc.valueType = edits.valueType;
    if (edits.canonicalUnit !== undefined) doc.canonicalUnit = edits.canonicalUnit;
    if (edits.units !== undefined) doc.units = edits.units;
    if (edits.toleranceKind !== undefined) doc.toleranceKind = edits.toleranceKind;
    if (edits.tolerance !== undefined) doc.tolerance = edits.tolerance;
    if (edits.authorityOrder !== undefined) doc.authorityOrder = edits.authorityOrder;
    if (edits.stalenessWindowMs !== undefined) doc.stalenessWindowMs = edits.stalenessWindowMs;
  }

  /**
   * Fails OPEN: by the time this runs, `confirm`/`update` has already persisted the status
   * transition and version bump — a human's decision is done. This method's own outcome, success
   * or thrown, is recorded on `doc.lastRescan` and saved, never rolled back and never rethrown to
   * the caller, so a conflict scan that happens to fail can never take the confirmation down with
   * it. `runRescan`'s only failure a caller sees is a bug in this method itself, before the
   * try/catch is reached.
   */
  private async runRescan(doc: MeasureDocument, tenantId: string): Promise<void> {
    await this.extractedFactModel.updateMany(
      { tenantId, measureId: doc._id },
      { $set: { measureStatus: 'confirmed' } },
    );
    const facts = await this.extractedFactModel.find(
      { tenantId, measureId: doc._id },
      { factKey: 1 },
    );
    const factKeys = facts.map((fact) => fact.factKey);

    const startedAt = Date.now();
    try {
      const scan = await this.conflictsService.scanForConflicts(tenantId, factKeys);
      doc.lastRescan = {
        at: new Date(),
        status: 'completed',
        durationMs: Date.now() - startedAt,
        conflictsCreated: scan.conflictsCreated,
        skippedFactCount: scan.skippedFactCount,
      };
    } catch (error) {
      this.logger.warn(
        `Rescan failed for measure '${doc._id.toString()}' in tenant '${tenantId}': ${String(error)}`,
      );
      doc.lastRescan = {
        at: new Date(),
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: String(error),
      };
    }

    await doc.save();
  }
}
