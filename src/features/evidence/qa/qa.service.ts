import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Answer, AnswerDocument } from '../../../database/schemas/evidence/answer/answer.schema';
import type { AnswerRunStatus } from '../../../database/schemas/evidence/answer/answer.schema';
import type { WorkflowEngine } from '../../../providers/workflow-engine/workflow-engine.interface';
import { WORKFLOW_ENGINE } from '../../../providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { AnswerQuestionInput } from '../../../workflows/types';
import type { AnswerContract, Citation } from './contracts/answer.contract';
import { AnswerNotFoundException } from './exceptions/qa.exception';

export interface StartQuestionInput {
  readonly questionText: string;
  readonly actorId: string;
}

export interface StartQuestionResult {
  readonly id: string;
  readonly runStatus: AnswerRunStatus;
}

export interface AnswerEnvelope {
  readonly id: string;
  readonly questionText: string;
  readonly runStatus: AnswerRunStatus;
  readonly outcome?: AnswerContract;
  readonly claimCoverage?: number;
  readonly citations: Citation[];
  readonly conflictIds: string[];
  readonly createdAt: Date;
}

/**
 * `answerQuestion` — the Temporal workflow type name in `src/workflows/answer-question.workflow.ts`
 * — is not exported as a constant anywhere in `src/workflows/**` (that directory only exports
 * argument/return types; see its `types.ts` top-of-file comment on the determinism fence). The
 * string is duplicated here rather than imported to keep this feature module from reaching into
 * `src/workflows/**` for anything but types.
 */
const ANSWER_QUESTION_WORKFLOW_TYPE = 'answerQuestion';

@Injectable()
export class QaService {
  constructor(
    @InjectModel(Answer.name)
    private readonly answerModel: Model<AnswerDocument>,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(QaService.name);
  }

  /**
   * Creates the `queued` `Answer` row this endpoint is the API-side trigger for (see
   * `AnswerPersistenceService`'s doc comment: "the API-side trigger that would create one is
   * wired in a later step" — this is that step). The workflow is started with the existing
   * `AnswerQuestionInput` shape only — no `answerId` travels through it, since `src/workflows/**`
   * is committed and out of scope here; a later step is responsible for having the worker resolve
   * back to this row.
   */
  async startQuestion(input: StartQuestionInput): Promise<StartQuestionResult> {
    const answer = await this.answerModel.create({
      questionText: input.questionText,
      runStatus: 'queued',
    });

    await this.workflowEngine.start(ANSWER_QUESTION_WORKFLOW_TYPE, {
      questionText: input.questionText,
    } satisfies AnswerQuestionInput);

    await this.auditService.record({
      action: 'qa.question.started',
      actorId: input.actorId,
      subject: { entityType: 'Answer', entityId: answer._id.toString() },
    });

    this.logger.debug(`Started question as answer '${answer._id.toString()}'`);

    return { id: answer._id.toString(), runStatus: answer.runStatus };
  }

  async getAnswerById(id: string, actorId: string): Promise<AnswerEnvelope> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AnswerNotFoundException(`Answer '${id}' not found`);
    }

    const answer = await this.answerModel.findById(id);
    if (!answer) {
      throw new AnswerNotFoundException(`Answer '${id}' not found`);
    }

    await this.auditService.record({
      action: 'qa.answer.viewed',
      actorId,
      subject: { entityType: 'Answer', entityId: answer._id.toString() },
    });

    return this.toAnswerEnvelope(answer);
  }

  private toAnswerEnvelope(answer: AnswerDocument): AnswerEnvelope {
    return {
      id: answer._id.toString(),
      questionText: answer.questionText,
      runStatus: answer.runStatus,
      // `answer.outcome` may be set behind the schema's own `pre('validate')` guard, but this
      // branch is the API-side half of "never present outcome as final ahead of runStatus" — a
      // client reading this envelope on a queued/running/failed answer must see no outcome at
      // all, not a stale or premature one.
      outcome: answer.runStatus === 'completed' ? answer.outcome : undefined,
      claimCoverage: answer.claimCoverage,
      // Flattened from `answer.claims` (the server-verified surviving claims), not
      // `answer.outcome.claims` (the model's raw, pre-verification output) — see `Answer.claims`'s
      // doc comment in `answer.schema.ts`.
      citations: answer.claims.flatMap((claim) => claim.citations),
      conflictIds: answer.conflictIds.map((conflictId) => conflictId.toString()),
      createdAt: answer.createdAt,
    };
  }
}
