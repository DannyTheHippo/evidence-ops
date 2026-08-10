import { Injectable } from '@nestjs/common';
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
    const candidates = detectConflicts(
      facts.map((fact) => ({
        id: fact._id.toString(),
        factKey: fact.factKey,
        value: fact.value,
      })),
      METRIC_ONTOLOGY,
    );

    if (candidates.length === 0) {
      this.logger.debug(`No conflicts detected for tenant '${tenantId}'`);
      return { conflictsCreated: 0 };
    }

    const openConflicts = await this.conflictModel.find({ tenantId, status: 'open' });
    const alreadyOpenKeys = new Set(openConflicts.map((conflict) => groupKey(conflict.factKey)));
    const newCandidates = candidates.filter(
      (candidate) => !alreadyOpenKeys.has(groupKey(candidate.factKey)),
    );

    if (newCandidates.length === 0) {
      this.logger.debug(`All detected conflicts for tenant '${tenantId}' are already open`);
      return { conflictsCreated: 0 };
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

    return { conflictsCreated: newCandidates.length };
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
