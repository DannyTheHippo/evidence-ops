import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../database/constants/tenant.constant';
import { Answer, AnswerDocument } from '../../../database/schemas/evidence/answer/answer.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { AnswerContract, Claim, VerificationReport } from './contracts/answer.contract';

export interface PersistAnswerInput {
  readonly questionText: string;
  readonly tenantId?: string;
  readonly retrievedChunkIds: readonly string[];
  readonly outcome: AnswerContract;
  readonly claims: readonly Claim[];
  readonly claimCoverage?: number;
  readonly verificationReport?: VerificationReport;
}

export interface PersistAnswerResult {
  readonly answerId: string;
  readonly outcomeKind: AnswerContract['kind'];
  readonly claimCoverage?: number;
}

/**
 * Single insert, `runStatus: 'completed'` from the start — there is no pre-created `queued`
 * `Answer` to update. `ProvidersModule`'s comment on `WORKFLOW_ENGINE` says the API-side trigger
 * that would create one is "wired in a later step", and a run that fails before reaching this
 * activity writes nothing at all: per ADR-0003, Temporal (not a hand-rolled `runStatus: 'failed'`
 * row) is the system of record for a failed or still-retrying run. `Answer.schema.ts`'s
 * `pre('validate')` hook — `outcome` may only be set alongside `runStatus: 'completed'` — is
 * satisfied because both always arrive together on this path.
 */
@Injectable()
export class AnswerPersistenceService {
  constructor(
    @InjectModel(Answer.name)
    private readonly answerModel: Model<AnswerDocument>,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(AnswerPersistenceService.name);
  }

  async persist(input: PersistAnswerInput): Promise<PersistAnswerResult> {
    const answer = await this.answerModel.create({
      questionText: input.questionText,
      runStatus: 'completed',
      retrievedChunkIds: input.retrievedChunkIds.map((id) => new Types.ObjectId(id)),
      outcome: input.outcome,
      // `Answer.claims` (`Claim[]`, mutable) doesn't accept `PersistAnswerInput.claims`'s
      // `readonly Claim[]` directly — spread rather than widen the input contract's own type.
      claims: [...input.claims],
      claimCoverage: input.claimCoverage,
      verificationReport: input.verificationReport,
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
    });

    this.logger.debug(
      `Persisted answer '${answer._id.toString()}' with outcome '${input.outcome.kind}'`,
    );

    return {
      answerId: answer._id.toString(),
      outcomeKind: input.outcome.kind,
      claimCoverage: answer.claimCoverage,
    };
  }
}
