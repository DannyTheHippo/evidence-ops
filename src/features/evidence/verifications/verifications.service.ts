import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Verification,
  VerificationDocument,
  type VerificationRequester,
  type VerificationUsage,
} from '../../../database/schemas/evidence/verification/verification.schema';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import type { VerifyClaimResult } from '../qa/contracts/verify-claims.contract';
import type { ClaimAtoms } from '../qa/types/claim-atoms.type';
import {
  DEFAULT_VERIFICATION_SORT_DIRECTION,
  DEFAULT_VERIFICATION_SORT_FIELD,
  type ListVerificationsRequestDto,
} from './dtos/request/list-verifications.request.dto';
import { VerificationNotFoundException } from './exceptions/verifications.exception';

export interface RecordVerificationInput {
  readonly tenantId: string;
  readonly requestedBy: VerificationRequester;
  readonly claims: readonly string[];
  readonly results: readonly VerifyClaimResult[];
  readonly advisory: string;
  readonly retrievedChunkIds: readonly string[];
  readonly atoms: readonly ClaimAtoms[];
  readonly usage: VerificationUsage;
}

export interface VerificationResult {
  readonly id: string;
  readonly requestedBy: VerificationRequester;
  readonly claims: string[];
  readonly results: VerifyClaimResult[];
  readonly advisory: string;
  readonly retrievedChunkIds: string[];
  readonly atoms: ClaimAtoms[];
  readonly usage: VerificationUsage;
  readonly createdAt: Date;
}

@Injectable()
export class VerificationsService {
  constructor(
    @InjectModel(Verification.name)
    private readonly verificationModel: Model<VerificationDocument>,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(VerificationsService.name);
  }

  /** Persists one `verify_claims` run. Called from the MCP tool path and the answer workflow — see
   *  `VerificationsController`'s own doc comment for why there is no HTTP route that calls this. */
  async record(input: RecordVerificationInput): Promise<{ id: string }> {
    const verification = await this.verificationModel.create({
      tenantId: input.tenantId,
      requestedBy: input.requestedBy,
      claims: [...input.claims],
      results: [...input.results],
      advisory: input.advisory,
      retrievedChunkIds: [...input.retrievedChunkIds],
      atoms: [...input.atoms],
      usage: input.usage,
    });

    this.logger.debug(`Recorded verification run '${verification._id.toString()}'`);

    return { id: verification._id.toString() };
  }

  /** Tenant-scoped read of the verification run history, newest first. No audit call — matches
   *  `QaService.listByTenant`'s identical reasoning: browsing the run list is not an audited
   *  action, only viewing one run's detail (`getById` below) is. */
  async list(
    dto: ListVerificationsRequestDto,
    tenantId: string,
  ): Promise<DocumentResultWithCount<VerificationResult>> {
    const filter = {
      tenantId,
      ...(dto.requestedByKind ? { 'requestedBy.kind': dto.requestedByKind } : {}),
    };

    const [verifications, count] = await Promise.all([
      this.verificationModel.find(filter, null, {
        sort: resolveSort(
          dto.sort,
          dto.sortDir,
          DEFAULT_VERIFICATION_SORT_FIELD,
          DEFAULT_VERIFICATION_SORT_DIRECTION,
        ),
        skip: dto.skip,
        limit: dto.limit,
      }),
      this.verificationModel.countDocuments(filter),
    ]);

    return { docs: verifications.map((verification) => this.toResult(verification)), count };
  }

  async getById(id: string, actorId: string, tenantId: string): Promise<VerificationResult> {
    if (!Types.ObjectId.isValid(id)) {
      throw new VerificationNotFoundException(`Verification '${id}' not found`);
    }

    // Cross-tenant id must be indistinguishable from a missing one — `findOne` with the tenant
    // predicate, not `findById` + a separate ownership check, matching `QaService.peekAnswer`.
    const verification = await this.verificationModel.findOne({ _id: id, tenantId });
    if (!verification) {
      throw new VerificationNotFoundException(`Verification '${id}' not found`);
    }

    await this.auditService.record({
      action: 'verifications.verification.viewed',
      actorId,
      subject: { entityType: 'Verification', entityId: verification._id.toString() },
      tenantId,
    });

    return this.toResult(verification);
  }

  private toResult(verification: VerificationDocument): VerificationResult {
    return {
      id: verification._id.toString(),
      requestedBy: verification.requestedBy,
      claims: verification.claims,
      results: verification.results,
      advisory: verification.advisory,
      retrievedChunkIds: verification.retrievedChunkIds,
      atoms: verification.atoms,
      usage: verification.usage,
      createdAt: verification.createdAt,
    };
  }
}
