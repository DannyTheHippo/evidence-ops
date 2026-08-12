import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../database/constants/tenant.constant';
import {
  Answer,
  AnswerDocument,
  type AnswerUsage,
} from '../../../database/schemas/evidence/answer/answer.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { AnswerContract, Claim, VerificationReport } from './contracts/answer.contract';
import { AnswerNotFoundException } from './exceptions/qa.exception';

export interface PersistAnswerInput {
  readonly answerId: string;
  readonly questionText: string;
  readonly tenantId?: string;
  readonly retrievedChunkIds: readonly string[];
  readonly outcome: AnswerContract;
  readonly claims: readonly Claim[];
  readonly claimCoverage?: number;
  readonly verificationReport?: VerificationReport;
  /** `Conflict._id`(s) that forced `outcome.kind === 'conflicting_evidence'` — absent (or `[]`,
   * on a retry after the outcome changed) whenever `outcome` is not that kind. See
   * `GroundingCheckActivityResult.conflictIds`'s doc comment in `../../../worker/activities.ts`. */
  readonly conflictIds?: readonly string[];
  /** Synthesis spend for this run (see `SynthesizeAnswerResult.usage`'s doc comment in
   * `synthesis.service.ts` — QA synthesis only, never embedding or extraction spend). Assigned
   * unconditionally below, not `if (usage)`: an activity retry that produces no usage must clear
   * a stale value rather than leave a prior attempt's number attached to a different attempt's
   * answer. */
  readonly usage?: AnswerUsage;
}

export interface PersistAnswerResult {
  readonly answerId: string;
  readonly outcomeKind: AnswerContract['kind'];
  readonly claimCoverage?: number;
}

/**
 * Updates the `queued` `Answer` row `QaService.startQuestion` created and threaded through as
 * `AnswerQuestionInput.answerId` — this is the "later step" the class used to describe itself as
 * waiting for. Loaded with `findById` and mutated via `.save()`, not `findByIdAndUpdate`: the
 * schema's `pre('validate')` invariant (`outcome` only alongside `runStatus: 'completed'`) is
 * document middleware, keyed off `this.invalidate(...)`, and only fires reliably on the
 * document-level save path (see `DocumentsService.addVersion` for the same
 * findById-then-mutate-then-save shape elsewhere in the codebase).
 *
 * Fails closed when the row is missing: a run that fails before reaching this activity leaves the
 * row `queued` forever rather than writing nothing (per ADR-0003, Temporal — not a hand-rolled
 * `runStatus: 'failed'` row — remains the system of record for a still-retrying run), but a
 * missing row at this point means the API-side create either never ran or wrote to a different id.
 * Silently creating a replacement row here would just reintroduce the original bug (two unrelated
 * answer rows) under a different id, so this throws instead.
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
    const answer = await this.answerModel.findById(input.answerId);
    if (!answer) {
      throw new AnswerNotFoundException(`Answer '${input.answerId}' not found`);
    }

    answer.runStatus = 'completed';
    // `EvidenceChunk._id` is a content-addressed string (`computeChunkId`), not an ObjectId — see
    // that schema's own doc comment. No coercion needed; copy as-is.
    answer.retrievedChunkIds = [...input.retrievedChunkIds];
    answer.outcome = input.outcome;
    // `Answer.claims` (`Claim[]`, mutable) doesn't accept `PersistAnswerInput.claims`'s
    // `readonly Claim[]` directly — spread rather than widen the input contract's own type.
    answer.claims = [...input.claims];
    answer.claimCoverage = input.claimCoverage;
    answer.verificationReport = input.verificationReport;
    // Unconditional assign, not "only when present": a retry that now resolves to a non-conflicting
    // outcome must clear ids a prior attempt already wrote, not leave them stale alongside the new
    // outcome. `Conflict._id` (unlike `EvidenceChunk._id` above) is a real ObjectId, so this
    // coercion is not the chunk-id bug `retrievedChunkIds`'s doc comment warns about.
    answer.conflictIds = (input.conflictIds ?? []).map((id) => new Types.ObjectId(id));
    answer.usage = input.usage;
    answer.tenantId = input.tenantId ?? DEFAULT_TENANT_ID;

    await answer.save();

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
