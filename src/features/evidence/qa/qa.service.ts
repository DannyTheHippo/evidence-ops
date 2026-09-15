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
  takeUntil,
  takeWhile,
  timer,
} from 'rxjs';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import { Answer, AnswerDocument } from '../../../database/schemas/evidence/answer/answer.schema';
import type {
  AnswerPath,
  AnswerRunStatus,
  AnswerUsage,
} from '../../../database/schemas/evidence/answer/answer.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import type { WorkflowEngine } from '../../../providers/workflow-engine/workflow-engine.interface';
import { WORKFLOW_ENGINE } from '../../../providers/workflow-engine/workflow-engine.interface';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_REAUTH_INTERVAL_MS,
  SSE_STREAM_ERROR_MESSAGE,
  SSE_STREAM_VIEW_AUDIT_DEDUPE_WINDOW_MS,
} from '../../../shared/constants/sse.constant';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { buildCreatedAtRange } from '../../../shared/utils/build-created-at-range.util';
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import { reauthTicks$, shouldRecordStreamView } from '../../../shared/utils/stream-session.util';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import type { AnswerQuestionInput } from '../../../workflows/types';
import { neutralizeForDisplay } from '../ingestion/sanitize-evidence-text';
import { WorkflowRunsService } from '../workflow-runs/workflow-runs.service';
import type { AnswerContract, Citation, VerificationReport } from './contracts/answer.contract';
import {
  DEFAULT_ANSWER_SORT_DIRECTION,
  DEFAULT_ANSWER_SORT_FIELD,
  type ListAnswersRequestDto,
} from './dtos/request/list-answers.request.dto';
import { AnswerResponseDto } from './dtos/response/answer.response.dto';
import { AnswerNotFoundException } from './exceptions/qa.exception';
import { ANSWER_STREAM_INTERVAL_MS } from './qa.constant';
import type { ClaimAtoms } from './types/claim-atoms.type';

export interface StartQuestionInput {
  readonly questionText: string;
  readonly actorId: string;
  readonly role: UserRole;
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
  readonly verificationReport?: VerificationReport;
  readonly citations: Citation[];
  readonly atoms: ClaimAtoms[];
  readonly conflictIds: string[];
  readonly createdAt: Date;
  readonly usage?: AnswerUsage;
  readonly retrievedChunkCount?: number;
  /** How the answer was produced — withheld until `runStatus === 'completed'`, the same gate
   * `outcome` follows above. */
  readonly answerPath?: AnswerPath;
  readonly attestationHash?: string;
  /**
   * Cited document versions that currently carry `withdrawnAt`, resolved fresh against
   * `DocumentVersion` on every read — never persisted alongside `citations`. Persisted citations
   * are the durable record of what was cited and must not be rewritten by a later corpus change;
   * this field layers the corpus's CURRENT state on top, so it can differ between two reads of
   * the same answer without the answer itself changing at all.
   */
  readonly withdrawnCitedDocVersionIds: string[];
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

    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly config: TypedConfigService,
    private readonly auditService: AuditService,
    private readonly workflowRunsService: WorkflowRunsService,
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

    const handle = await this.workflowEngine.start(ANSWER_QUESTION_WORKFLOW_TYPE, {
      answerId: answer._id.toString(),
      questionText: input.questionText,
      tenantId: input.tenantId,
    } satisfies AnswerQuestionInput);

    // Fails OPEN: the run row is a display projection, same class as `WorkflowRunsService.recordEnd`
    // (see its own doc comment) — the workflow has already started, so a write failure here must
    // not turn an otherwise-successful question into a 500.
    try {
      await this.workflowRunsService.create({
        workflowId: handle.id,
        workflowType: 'answer-question',
        status: handle.status,
        tenantId: input.tenantId,
        subjectId: answer._id.toString(),
        subjectType: 'Answer',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to record workflow run for answer '${answer._id.toString()}': ${message}`,
      );
    }

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
   * deduped opening record, ever write the audit row.
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

    const citedDocVersionIds = this.citedDocVersionIds(answer);
    const withdrawnDocVersionIds = await this.resolveWithdrawnDocVersionIds(
      citedDocVersionIds,
      tenantId,
    );

    return this.toAnswerEnvelope(
      answer,
      citedDocVersionIds.filter((docVersionId) => withdrawnDocVersionIds.has(docVersionId)),
    );
  }

  /**
   * Tenant-scoped read of the answer history, newest first. No audit call — browsing your own
   * answer list is not an audited action (matching `DocumentsService.list`); `getAnswerById` and
   * `peekAnswer` remain the audited reads of an individual answer. Every row is mapped through
   * `toAnswerEnvelope`, so the completed-only gate on `outcome`/`claimCoverage`/`verificationReport`/
   * `usage` applies per row for free rather than needing to be re-implemented here.
   */
  async listByTenant(
    dto: ListAnswersRequestDto,
    _actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<AnswerEnvelope>> {
    const filter = {
      tenantId,
      ...(dto.runStatus ? { runStatus: dto.runStatus } : {}),
      ...buildCreatedAtRange(dto.from, dto.to),
    };

    const [answers, count] = await Promise.all([
      this.answerModel.find(filter, null, {
        sort: resolveSort(
          dto.sort,
          dto.sortDir,
          DEFAULT_ANSWER_SORT_FIELD,
          DEFAULT_ANSWER_SORT_DIRECTION,
        ),
        skip: dto.skip,
        limit: dto.limit,
      }),
      this.answerModel.countDocuments(filter),
    ]);

    // Batched once for the whole page, not once per row — same reasoning
    // `resolveWithdrawnDocVersionIds` documents for `streamAnswer`'s per-tick poll.
    const pageDocVersionIds = [
      ...new Set(answers.flatMap((answer) => this.citedDocVersionIds(answer))),
    ];
    const withdrawnDocVersionIds = await this.resolveWithdrawnDocVersionIds(
      pageDocVersionIds,
      tenantId,
    );

    return {
      docs: answers.map((answer) =>
        this.toAnswerEnvelope(
          answer,
          this.citedDocVersionIds(answer).filter((docVersionId) =>
            withdrawnDocVersionIds.has(docVersionId),
          ),
        ),
      ),
      count,
    };
  }

  /**
   * Polling-on-the-server, deliberately not a MongoDB change stream: change streams would need a
   * per-connection cursor and behave differently between Atlas-Local and mongodb-memory-server,
   * buying sub-second latency nobody needs over `ANSWER_STREAM_INTERVAL_MS`. Upgrade path if that
   * ever changes: swap `timer`'s tick source for a change-stream `Observable` feeding the same
   * `concatMap(peekAnswer)` step below — everything downstream of that point stays the same.
   */
  streamAnswer(id: string, actorId: string, tenantId: string): Observable<MessageEvent> {
    // At most one audit row per `SSE_STREAM_VIEW_AUDIT_DEDUPE_WINDOW_MS` per (actor, answer) pair,
    // not one per stream OPEN — a reconnecting client would otherwise flood the audit log with rows
    // that say nothing new (`shouldRecordStreamView`, `stream-session.util.ts`). The initial peek
    // here still gates the write on existence — matching `getAnswerById`'s own
    // audit-after-confirmation order — so a stream opened against an unknown id is never recorded
    // as a view.
    const opened$ = defer(() => this.peekAnswer(id, tenantId)).pipe(
      concatMap((answer) => {
        if (
          !shouldRecordStreamView(
            `qa.answer.viewed:${actorId}:${answer.id}`,
            SSE_STREAM_VIEW_AUDIT_DEDUPE_WINDOW_MS,
          )
        ) {
          return of(undefined);
        }
        return this.auditService.record({
          action: 'qa.answer.viewed',
          actorId,
          subject: { entityType: 'Answer', entityId: answer.id },
          tenantId,
        });
      }),
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
      // Re-checked on every `SSE_REAUTH_INTERVAL_MS` tick, independent of the answer/heartbeat
      // cadence above — the initial `@CurrentUser()` check at subscribe time only proves the
      // session was valid then, and this connection can otherwise outlive a logout or a tenant
      // change for as long as the client keeps it open. See `reauthTicks$`'s own doc comment for
      // why a `reload` failure also ends the stream rather than being swallowed.
      takeUntil(
        reauthTicks$(
          { userId: actorId, tenantId },
          (userId) =>
            this.userModel
              .findById(userId)
              .then((user) => (user ? { tenantId: user.tenantId } : null)),
          SSE_REAUTH_INTERVAL_MS,
        ),
      ),
      // Absolute ceiling on a single connection, independent of every other terminal condition
      // here: a wedged answer that never reaches a terminal status, and a client that never
      // disconnects, would otherwise hold one of the user's `SSE_MAX_CONNECTIONS_PER_USER` slots
      // for as long as the process lives — past the session cookie's own expiry.
      takeUntil(timer(this.config.sse.maxStreamLifetimeMs)),
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

  /** Every distinct `docVersionId` this answer's server-verified citations name — the candidate
   *  set `resolveWithdrawnDocVersionIds` checks against `DocumentVersion`. Reads `answer.claims`,
   *  matching `toAnswerEnvelope`'s own `citations` field below: it carries the gate-verified
   *  claim set for every outcome kind, whereas `answer.outcome.claims` only exists at all on the
   *  `answered` variant. */
  private citedDocVersionIds(answer: AnswerDocument): string[] {
    return [
      ...new Set(answer.claims.flatMap((claim) => claim.citations.map((c) => c.docVersionId))),
    ];
  }

  /**
   * Batch-resolves which of the given document version ids currently carry `withdrawnAt` — one
   * query for the whole candidate set, never per-citation. Short-circuits before that query when
   * `docVersionIds` is empty, which is the ONLY state a queued, running, or failed answer's
   * citations can be in (`claims`, and therefore citations, populate only on completion — see
   * `AnswerPersistenceService`). `streamAnswer`'s per-tick poll calls this via `peekAnswer` on
   * every tick, so this gate is what keeps that poll from paying for a query on every tick of
   * every open connection: citations first appear on the tick where `runStatus` reaches
   * 'completed', and `streamAnswer`'s own `takeWhile` ends the stream on that same tick, so this
   * query runs at most once per connection. Losing this gate silently reintroduces a query per
   * tick per open SSE connection.
   *
   * Filters to valid ObjectIds before querying rather than letting a malformed `docVersionId`
   * throw: a citation's `docVersionId` is a free-form string on the persisted `Answer.claims`
   * (`Citation.docVersionId` is `z.string().min(1)`, not an ObjectId format), so a value that
   * cannot resolve to a real `DocumentVersion` is treated the same as one that doesn't — never
   * withdrawn — not as a fault worth failing the whole read for.
   */
  private async resolveWithdrawnDocVersionIds(
    docVersionIds: readonly string[],
    tenantId: string,
  ): Promise<ReadonlySet<string>> {
    const validIds = docVersionIds.filter((id) => Types.ObjectId.isValid(id));
    if (validIds.length === 0) {
      return new Set();
    }

    const withdrawnVersions = await this.documentVersionModel.find(
      {
        _id: { $in: validIds.map((id) => new Types.ObjectId(id)) },
        tenantId,
        withdrawnAt: { $exists: true },
      },
      { _id: 1 },
    );
    return new Set(withdrawnVersions.map((version) => version._id.toString()));
  }

  // The stored citation stays byte-faithful to its source (`locateQuote`'s verbatim match depends
  // on it); this is the human-viewer boundary where display-only neutralization — stripping
  // control/bidi/zero-width characters — belongs instead, per `neutralizeForDisplay`'s own doc
  // comment. Matches `DocumentsService.toChunkDto`'s identical treatment of chunk text.
  private neutralizeCitation(citation: Citation): Citation {
    return { ...citation, quote: neutralizeForDisplay(citation.quote) };
  }

  // `outcome.claims[].citations[].quote` carries the same raw model-cited quote as the flattened
  // `citations` field below — both need the same display-boundary neutralization, or the `answered`
  // branch would still leak a raw quote through `outcome` alone.
  private neutralizeOutcome(outcome: AnswerContract): AnswerContract {
    if (outcome.kind !== 'answered') {
      return outcome;
    }
    return {
      ...outcome,
      claims: outcome.claims.map((claim) => ({
        ...claim,
        citations: claim.citations.map((citation) => this.neutralizeCitation(citation)),
      })),
    };
  }

  private toAnswerEnvelope(
    answer: AnswerDocument,
    withdrawnCitedDocVersionIds: string[],
  ): AnswerEnvelope {
    return {
      id: answer._id.toString(),
      questionText: answer.questionText,
      runStatus: answer.runStatus,
      // `answer.outcome` may be set behind the schema's own `pre('validate')` guard, but this
      // branch is the API-side half of "never present outcome as final ahead of runStatus" — a
      // client reading this envelope on a queued/running/failed answer must see no outcome at
      // all, not a stale or premature one.
      outcome:
        answer.runStatus === 'completed' && answer.outcome
          ? this.neutralizeOutcome(answer.outcome)
          : undefined,
      // Same withholding rule as `outcome` above — `claimCoverage` is written alongside the
      // outcome on completion (see `answer-persistence.service.ts`), so it follows the same gate.
      claimCoverage: answer.runStatus === 'completed' ? answer.claimCoverage : undefined,
      // Same withholding rule as `outcome` above — the verification report is computed alongside
      // the outcome on completion (see `answer-persistence.service.ts`), so it follows the same gate.
      verificationReport: answer.runStatus === 'completed' ? answer.verificationReport : undefined,
      // Flattened from `answer.claims`, the server-verified surviving claims present for every
      // outcome kind — see `Answer.claims`'s doc comment in `answer.schema.ts`. Neutralized for
      // the same reason `outcome` above is: this is the response boundary, not storage or
      // verification, both of which still see the raw byte-faithful quote.
      citations: answer.claims.flatMap((claim) =>
        claim.citations.map((citation) => this.neutralizeCitation(citation)),
      ),
      // `?? []` covers rows persisted before this field existed — `answer.atoms` is undefined on
      // those, and the envelope must not hand `undefined` to a consumer expecting an array.
      atoms: answer.atoms ?? [],
      conflictIds: answer.conflictIds.map((conflictId) => conflictId.toString()),
      createdAt: answer.createdAt,
      // Same withholding rule as `outcome` above — usage is written alongside outcome on
      // completion (see `answer-persistence.service.ts`), so it follows the same gate.
      usage: answer.runStatus === 'completed' ? answer.usage : undefined,
      // Same withholding rule as `outcome` above. No optional chaining on `retrievedChunkIds` —
      // the schema default (`[]`) guarantees the array is always present, so a defensive `?.`
      // here would mask a real absence rather than express one.
      retrievedChunkCount:
        answer.runStatus === 'completed' ? answer.retrievedChunkIds.length : undefined,
      withdrawnCitedDocVersionIds,
      // Same withholding rule as `outcome` above — set alongside the outcome on completion.
      answerPath: answer.runStatus === 'completed' ? answer.answerPath : undefined,
      attestationHash: answer.attestationHash,
    };
  }
}
