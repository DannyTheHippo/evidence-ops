import { Inject, Injectable } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Observable } from 'rxjs';
import {
  catchError,
  concat,
  concatMap,
  defer,
  distinctUntilChanged,
  ignoreElements,
  map,
  merge,
  of,
  takeWhile,
  timer,
} from 'rxjs';
import { Answer, AnswerDocument } from '../../../database/schemas/evidence/answer/answer.schema';
import type {
  AnswerRunStatus,
  AnswerUsage,
} from '../../../database/schemas/evidence/answer/answer.schema';
import type { WorkflowEngine } from '../../../providers/workflow-engine/workflow-engine.interface';
import { WORKFLOW_ENGINE } from '../../../providers/workflow-engine/workflow-engine.interface';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_STREAM_ERROR_MESSAGE,
} from '../../../shared/constants/sse.constant';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import type { AnswerQuestionInput } from '../../../workflows/types';
import type { AnswerContract, Citation } from './contracts/answer.contract';
import { AnswerResponseDto } from './dtos/response/answer.response.dto';
import { AnswerNotFoundException } from './exceptions/qa.exception';
import { ANSWER_STREAM_INTERVAL_MS } from './qa.constant';

export interface StartQuestionInput {
  readonly questionText: string;
  readonly actorId: string;
  readonly tenantId: string;
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
  readonly usage?: AnswerUsage;
}

/**
 * `answerQuestion` — the Temporal workflow type name in `src/workflows/answer-question.workflow.ts`
 * — is not exported as a constant anywhere in `src/workflows/**` (that directory only exports
 * argument/return types; see its `types.ts` top-of-file comment on the determinism fence). The
 * string is duplicated here rather than imported to keep this feature module from reaching into
 * `src/workflows/**` for anything but types.
 */
const ANSWER_QUESTION_WORKFLOW_TYPE = 'answerQuestion';

// `AnswerContract`'s outcome is what a *completed* run reports; runStatus is the coarser workflow
// lifecycle `streamAnswer`'s terminal check actually gates on — see `Answer.schema.ts`'s
// pre('validate') hook for why the two axes are kept separate.
const isTerminalAnswerRunStatus = (status: AnswerRunStatus): boolean =>
  status === 'completed' || status === 'failed';

// Internal to `streamAnswer` only — `heartbeat`'s payload is always `{}`, so `Record<string,
// never>` documents that at the type level rather than widening to `object`.
type AnswerStreamEvent =
  { type: 'answer'; data: AnswerResponseDto } | { type: 'heartbeat'; data: Record<string, never> };

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
   * Creates the `queued` `Answer` row and threads its id through as `AnswerQuestionInput.answerId`
   * so `persistAnswer` updates this same row instead of creating an unrelated one — `GET
   * /api/v1/answers/:id` (`getAnswerById` below) only ever observes completion because both sides
   * now agree on one id.
   */
  async startQuestion(input: StartQuestionInput): Promise<StartQuestionResult> {
    const answer = await this.answerModel.create({
      questionText: input.questionText,
      runStatus: 'queued',
      tenantId: input.tenantId,
    });

    await this.workflowEngine.start(ANSWER_QUESTION_WORKFLOW_TYPE, {
      answerId: answer._id.toString(),
      questionText: input.questionText,
      tenantId: input.tenantId,
    } satisfies AnswerQuestionInput);

    await this.auditService.record({
      action: 'qa.question.started',
      actorId: input.actorId,
      subject: { entityType: 'Answer', entityId: answer._id.toString() },
      tenantId: input.tenantId,
    });

    this.logger.debug(`Started question as answer '${answer._id.toString()}'`);

    return { id: answer._id.toString(), runStatus: answer.runStatus };
  }

  async getAnswerById(id: string, actorId: string, tenantId: string): Promise<AnswerEnvelope> {
    const answer = await this.peekAnswer(id, tenantId);

    await this.auditService.record({
      action: 'qa.answer.viewed',
      actorId,
      subject: { entityType: 'Answer', entityId: answer.id },
      tenantId,
    });

    return answer;
  }

  /**
   * The audit-free half of `getAnswerById` — reused by `streamAnswer`'s per-tick poll below, where
   * an audit row per tick (every 1.5s for the life of an open connection) would flood the audit
   * log for what is still, from the caller's perspective, one "viewing an answer" action.
   * `getAnswerById` delegates here so the two paths cannot drift; only it, and `streamAnswer`'s
   * one-per-open record, ever write the audit row.
   */
  async peekAnswer(id: string, tenantId: string): Promise<AnswerEnvelope> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AnswerNotFoundException(`Answer '${id}' not found`);
    }

    // Cross-tenant id must be indistinguishable from a missing one — `findOne` with the tenant
    // predicate, not `findById` + a separate ownership check, so a wrong-tenant id 404s the same
    // way a nonexistent one does rather than confirming existence via a different error shape.
    const answer = await this.answerModel.findOne({ _id: id, tenantId });
    if (!answer) {
      throw new AnswerNotFoundException(`Answer '${id}' not found`);
    }

    return this.toAnswerEnvelope(answer);
  }

  /**
   * Polling-on-the-server, deliberately not a MongoDB change stream: change streams would need a
   * per-connection cursor and behave differently between Atlas-Local and mongodb-memory-server,
   * buying sub-second latency nobody needs over `ANSWER_STREAM_INTERVAL_MS`. Upgrade path if that
   * ever changes: swap `timer`'s tick source for a change-stream `Observable` feeding the same
   * `concatMap(peekAnswer)` step below — everything downstream of that point stays the same.
   */
  streamAnswer(id: string, actorId: string, tenantId: string): Observable<MessageEvent> {
    // One audit row per stream OPEN, not per tick. The initial peek here also gates the audit on
    // existence — matching `getAnswerById`'s own audit-after-confirmation order — so a stream
    // opened against an unknown id is never recorded as a view.
    const opened$ = defer(() => this.peekAnswer(id, tenantId)).pipe(
      concatMap((answer) =>
        this.auditService.record({
          action: 'qa.answer.viewed',
          actorId,
          subject: { entityType: 'Answer', entityId: answer.id },
          tenantId,
        }),
      ),
      ignoreElements(),
    );

    const answer$: Observable<AnswerStreamEvent> = timer(0, ANSWER_STREAM_INTERVAL_MS).pipe(
      concatMap(() => this.peekAnswer(id, tenantId)),
      map((answer) => toResponseDto(AnswerResponseDto, answer)),
      // Fresh DTO instance every tick, so comparing serialized JSON (not object identity) is what
      // actually suppresses a re-emit when nothing changed between polls.
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      map((data): AnswerStreamEvent => ({ type: 'answer', data })),
    );

    const heartbeat$: Observable<AnswerStreamEvent> = timer(
      SSE_HEARTBEAT_INTERVAL_MS,
      SSE_HEARTBEAT_INTERVAL_MS,
    ).pipe(map((): AnswerStreamEvent => ({ type: 'heartbeat', data: {} })));

    return concat(opened$, merge(answer$, heartbeat$)).pipe(
      // Inclusive: the terminal answer event itself must reach the client before the stream ends —
      // an exclusive takeWhile would close the connection without ever sending the state the
      // caller most needs. Applied to the MERGED stream, not just `answer$`, so completing here
      // also tears down the otherwise-infinite heartbeat timer; a per-branch takeWhile would leave
      // heartbeat$ running forever, since `merge()` only completes once every source has.
      takeWhile(
        (event) => !(event.type === 'answer' && isTerminalAnswerRunStatus(event.data.runStatus)),
        true,
      ),
      map((event): MessageEvent => event),
      // FAIL OPEN TO POLLING: an unknown id, a Mongo hiccup, or any other read failure becomes a
      // terminal `error` event rather than a 5xx tearing down the connection — the SPA's retained
      // GET /answers/:id polling path is the fallback, and it must still be able to run after this
      // stream ends rather than race a half-closed connection. The event carries a fixed
      // client-facing message, not `(error as Error).message` — this `catchError` sits outside
      // `GlobalExceptionFilter`, so the raw message would otherwise leak internals to the browser
      // (see `SSE_STREAM_ERROR_MESSAGE`'s doc comment); the real error is logged here instead.
      catchError((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`streamAnswer failed for answer '${id}': ${message}`);
        return of<MessageEvent>({ type: 'error', data: { message: SSE_STREAM_ERROR_MESSAGE } });
      }),
    );
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
      // Same withholding rule as `outcome` above — usage is written alongside outcome on
      // completion (see `answer-persistence.service.ts`), so it follows the same gate.
      usage: answer.runStatus === 'completed' ? answer.usage : undefined,
    };
  }
}
