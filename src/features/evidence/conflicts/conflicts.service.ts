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
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { METRIC_ONTOLOGY } from '../facts/metric-ontology';
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

    private readonly logger: AppLogger,
  ) {
    this.logger.init(ConflictsService.name);
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
}
