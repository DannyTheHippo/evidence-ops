import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../database/constants/tenant.constant';
import {
  Conflict,
  ConflictDocument,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
  type FactKey,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { METRIC_ONTOLOGY } from '../facts/metric-ontology';
import { ConflictResponseDto } from './dtos/response/conflict.response.dto';
import { detectConflicts, groupKey } from './detect-conflicts';

export interface ConflictScanResult {
  readonly conflictsCreated: number;
  /** Facts `detectConflicts` could not normalize (an unrecognized unit) and dropped from this
   * scan — also logged individually at `warn` (see `scanForConflicts`), but surfaced here too so a
   * caller (the `eval` harness, a future admin surface) can assert on or alert on the count without
   * scraping logs. Zero on every run where every fact's unit was recognized. */
  readonly skippedFactCount: number;
}

/** One side of an open `Conflict`, projected for `GroundingGateService.verify`'s
 * `conflicting_evidence` outcome — shaped to match `conflictingValueSchema`
 * (`../qa/contracts/answer.contract.ts`) field-for-field. */
export interface ConflictedFactValue {
  readonly value: number;
  readonly unit: string;
  readonly sourceChunkId: string;
}

/** An open `Conflict`'s fact key plus every one of its `factIds`' current values — not just the
 * fact touched by a request's retrieved chunk, since `conflictingEvidenceOutcomeSchema` requires
 * the *whole* disagreement (`values.min(2)`), not one side of it. */
export interface ConflictedFactGroup {
  readonly factKey: FactKey;
  readonly values: readonly ConflictedFactValue[];
}

@Injectable()
export class ConflictsService {
  constructor(
    @InjectModel(ExtractedFact.name)
    private readonly extractedFactModel: Model<ExtractedFactDocument>,

    @InjectModel(Conflict.name)
    private readonly conflictModel: Model<ConflictDocument>,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(ConflictsService.name);
  }

  /**
   * Audit subject: a paginated list has no single conflict to attach the event to, so the
   * requesting user stands in as the subject rather than a fabricated ObjectId that would
   * dangle with no referent.
   */
  async list(
    pagination: PaginationRequestDto,
    actorId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<DocumentResultWithCount<ConflictResponseDto>> {
    const filter = { tenantId };

    const [conflicts, count] = await Promise.all([
      this.conflictModel.find(filter, null, {
        sort: { createdAt: -1 },
        skip: pagination.skip,
        limit: pagination.limit,
      }),
      this.conflictModel.countDocuments(filter),
    ]);

    await this.auditService.record({
      action: 'conflicts.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return { docs: conflicts.map((conflict) => this.toConflictDto(conflict)), count };
  }

  /**
   * Scans every `ExtractedFact` for one tenant, groups by `(entity, metric, period)`, and
   * persists a `Conflict` for each group whose normalized values disagree by more than the
   * metric's tolerance.
   *
   * Idempotent by factKey rather than by a run identifier: a group that already has an `open`
   * `Conflict` is skipped, so re-running the scan after new evidence arrives only creates
   * conflicts for keys that did not already have one — it never duplicates an existing one, and it
   * never re-opens or touches a conflict a reviewer already resolved or dismissed (those statuses
   * are read as "already handled", not as "needs a fresh Conflict record").
   */
  async scanForConflicts(tenantId: string = DEFAULT_TENANT_ID): Promise<ConflictScanResult> {
    const facts = await this.extractedFactModel.find({ tenantId });
    const { conflicts: candidates, skipped } = detectConflicts(
      facts.map((fact) => ({
        id: fact._id.toString(),
        factKey: fact.factKey,
        value: fact.value,
      })),
      METRIC_ONTOLOGY,
    );

    // A silently-dropped fact is a fact that can never conflict — the quiet correctness loss this
    // whole scan exists to prevent — so every skip is logged individually with the context (fact
    // id, metric, unit) needed to act on it, not just counted.
    for (const { fact, reason } of skipped) {
      this.logger.warn(
        `Skipped fact '${fact.id}' (metric '${fact.factKey.metric}', unit '${fact.value.unit}') from conflict detection: ${reason}`,
      );
    }

    if (candidates.length === 0) {
      this.logger.debug(`No conflicts detected for tenant '${tenantId}'`);
      return { conflictsCreated: 0, skippedFactCount: skipped.length };
    }

    const openConflicts = await this.conflictModel.find({ tenantId, status: 'open' });
    const alreadyOpenKeys = new Set(openConflicts.map((conflict) => groupKey(conflict.factKey)));
    const newCandidates = candidates.filter(
      (candidate) => !alreadyOpenKeys.has(groupKey(candidate.factKey)),
    );

    if (newCandidates.length === 0) {
      this.logger.debug(`All detected conflicts for tenant '${tenantId}' are already open`);
      return { conflictsCreated: 0, skippedFactCount: skipped.length };
    }

    await this.conflictModel.insertMany(
      newCandidates.map((candidate) => ({
        factKey: candidate.factKey,
        factIds: candidate.factIds.map((id) => new Types.ObjectId(id)),
        magnitude: candidate.magnitude,
        status: 'open',
        tenantId,
      })),
    );

    this.logger.debug(`Created ${newCandidates.length} conflicts for tenant '${tenantId}'`);

    return { conflictsCreated: newCandidates.length, skippedFactCount: skipped.length };
  }

  /**
   * Open conflicts touched by a request's retrieved evidence, scoped to `chunkIds` and
   * `tenantId`. "Touched" means at least one of the conflict's `factIds` was extracted from one of
   * `chunkIds` — a request must never be able to force `conflicting_evidence` off a conflict in a
   * document it never retrieved, so this deliberately does not scan the tenant's whole `conflicts`
   * collection. `resolved`/`dismissed` conflicts are excluded for the same reason
   * `scanForConflicts` treats them as already handled.
   */
  async findConflictedFactGroupsForChunks(
    chunkIds: readonly string[],
    tenantId: string,
  ): Promise<ConflictedFactGroup[]> {
    if (chunkIds.length === 0) {
      return [];
    }

    const touchedFacts = await this.extractedFactModel.find(
      { chunkId: { $in: [...chunkIds] }, tenantId },
      { _id: 1 },
    );
    if (touchedFacts.length === 0) {
      return [];
    }

    const conflicts = await this.conflictModel.find({
      tenantId,
      status: 'open',
      factIds: { $in: touchedFacts.map((fact) => fact._id) },
    });
    if (conflicts.length === 0) {
      return [];
    }

    const everyFactId = [
      ...new Set(conflicts.flatMap((conflict) => conflict.factIds.map((id) => id.toString()))),
    ].map((id) => new Types.ObjectId(id));
    const conflictingFacts = await this.extractedFactModel.find({ _id: { $in: everyFactId } });
    const factById = new Map(conflictingFacts.map((fact) => [fact._id.toString(), fact]));

    return conflicts.map((conflict) => {
      const values: ConflictedFactValue[] = [];
      for (const id of conflict.factIds) {
        const fact = factById.get(id.toString());
        if (!fact) {
          continue;
        }
        values.push({
          value: fact.value.amount,
          unit: fact.value.unit,
          sourceChunkId: fact.chunkId,
        });
      }

      if (values.length < conflict.factIds.length) {
        // A `Conflict.factIds` reference that no longer resolves to an `ExtractedFact` is a
        // data-integrity fault, not a normal degradation path (mirrors
        // `EvidenceRetrievalService`'s deleted-version throw) — `conflictingEvidenceOutcomeSchema`
        // requires >= 2 `values`, and silently persisting a group short of the conflict's real
        // factIds would emit either a schema-invalid outcome or a `conflicting_evidence` answer
        // that understates a real disagreement.
        throw new InternalServerErrorException(
          `Conflict '${conflict._id.toString()}' references ${conflict.factIds.length} fact(s), but only ${values.length} still resolve to an ExtractedFact`,
        );
      }

      return {
        factKey: {
          entity: conflict.factKey.entity,
          metric: conflict.factKey.metric,
          period: conflict.factKey.period,
        },
        values,
      };
    });
  }

  private toConflictDto(conflict: ConflictDocument): ConflictResponseDto {
    return {
      id: conflict._id.toString(),
      // Spread rather than pass `conflict.factKey` through by reference: unlike
      // `ExtractedFact.factKey` (which uses an explicit `{ _id: false }` sub-schema), this path's
      // inline `{ type: {...} }` shorthand lets Mongoose mint an `_id` on the nested subdocument
      // — spreading the three declared fields keeps that stray id out of the response.
      factKey: {
        entity: conflict.factKey.entity,
        metric: conflict.factKey.metric,
        period: conflict.factKey.period,
      },
      factIds: conflict.factIds.map((id) => id.toString()),
      magnitude: conflict.magnitude,
      status: conflict.status,
      createdAt: conflict.createdAt,
    };
  }
}
