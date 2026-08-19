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
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import {
  WorkflowRun,
  WorkflowRunDocument,
  type WorkflowRunStatus,
  type WorkflowRunType,
} from '../../../database/schemas/workflow/workflow-run/workflow-run.schema';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../providers/workflow-engine/workflow-engine.interface';
import {
  DEFAULT_PAGINATION_LIMIT,
  DEFAULT_PAGINATION_SKIP,
} from '../../../shared/constants/pagination-defaults.constant';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_REAUTH_INTERVAL_MS,
  SSE_STREAM_ERROR_MESSAGE,
  SSE_STREAM_VIEW_AUDIT_DEDUPE_WINDOW_MS,
} from '../../../shared/constants/sse.constant';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { reauthTicks$, shouldRecordStreamView } from '../../../shared/utils/stream-session.util';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { ApprovalsService } from '../approvals/approvals.service';
import { ApprovalResponseDto } from '../approvals/dtos/response/approval.response.dto';
import type { ListWorkflowRunsRequestDto } from './dtos/request/list-workflow-runs.request.dto';
import { WorkflowRunResponseDto } from './dtos/response/workflow-run.response.dto';
import { WorkflowRunNotFoundException } from './exceptions/workflow-runs.exception';
import { WORKFLOW_RUN_STREAM_INTERVAL_MS } from './workflow-runs.constant';

export interface CreateWorkflowRunInput {
  readonly workflowId: string;
  readonly workflowType: WorkflowRunType;
  readonly status: WorkflowRunStatus;
  readonly tenantId?: string;
}

export interface WorkflowRunResult {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowType?: WorkflowRunType;
  readonly status: WorkflowRunStatus;
  readonly errorMessage?: string;
  readonly createdAt: Date;
}

const isTerminalWorkflowRunStatus = (status: WorkflowRunStatus): boolean =>
  status === 'completed' || status === 'failed';

// Internal to `streamRun` only. `approvals` carries the whole pending-approval inbox (the same
// `{docs,count}` shape `GET /approvals` returns), not a single approval matched to this run — see
// `streamRun`'s own doc comment for why.
type WorkflowRunStreamEvent =
  | { type: 'run'; data: WorkflowRunResponseDto }
  | { type: 'approvals'; data: { docs: ApprovalResponseDto[]; count: number } }
  | { type: 'heartbeat'; data: Record<string, never> };

@Injectable()
export class WorkflowRunsService {
  constructor(
    @InjectModel(WorkflowRun.name)
    private readonly workflowRunModel: Model<WorkflowRunDocument>,

    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly approvalsService: ApprovalsService,
    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(WorkflowRunsService.name);
  }

  /**
   * Creates the durable projection a caller who just started a workflow hands back, so a client
   * has an id to poll `GET /workflow-runs/:id` with. Two callers write here:
   * `ConflictsService.requestResolution` and `SourcesService.requestSync` — `answer-question` and
   * `ingest-document-version` run without a projection, so no run row exists for them.
   */
  async create(input: CreateWorkflowRunInput): Promise<WorkflowRunResult> {
    const run = await this.workflowRunModel.create({
      workflowId: input.workflowId,
      workflowType: input.workflowType,
      status: input.status,
      tenantId: input.tenantId,
    });

    return this.toResult(run);
  }

  /**
   * Tenant-scoped read of the durable row, refreshed best-effort against the live engine status.
   * FAILS OPEN on the engine call: `WorkflowEngine.status()` is a measurement of a downstream
   * system's state for display, never a permission gate on anything — a Temporal outage or a
   * stale/expired handle must not turn a legitimate poll of an already-known run into an error, so
   * an engine failure is logged and the durable (possibly stale) row is returned as-is. Never
   * written back to Mongo: this method only merges the live status into the response it returns,
   * so a GET here stays a read, and the persisted row remains whatever the workflow's own
   * activities last recorded.
   */
  async findById(id: string, actorId: string, tenantId: string): Promise<WorkflowRunResult> {
    const result = await this.peekRun(id, tenantId);

    await this.auditService.record({
      action: 'workflow-runs.viewed',
      actorId,
      subject: { entityType: 'WorkflowRun', entityId: result.id },
      tenantId,
    });

    return result;
  }

  /**
   * The audit-free half of `findById` — reused by `streamRun`'s per-tick poll below, where an
   * audit row per tick (every 1.5s for the life of an open connection) would flood the audit log
   * for what is still, from the caller's perspective, one "viewing a run" action. `findById`
   * delegates here so the two paths cannot drift. Keeps the same live-engine-status fail-open
   * refresh `findById` documented above — the SSE `run` event must match the polled GET
   * byte-for-byte, so this cannot skip that step.
   *
   * `streamRun`'s opening record (below) is the other writer of this action, deduped via
   * `shouldRecordStreamView`.
   */
  async peekRun(id: string, tenantId: string): Promise<WorkflowRunResult> {
    if (!Types.ObjectId.isValid(id)) {
      throw new WorkflowRunNotFoundException(`WorkflowRun '${id}' not found`);
    }

    const run = await this.workflowRunModel.findOne({ _id: id, tenantId });
    if (!run) {
      throw new WorkflowRunNotFoundException(`WorkflowRun '${id}' not found`);
    }

    let liveStatus: WorkflowRunStatus = run.status;
    try {
      const handle = await this.workflowEngine.status(run.workflowId);
      liveStatus = handle.status;
    } catch (error) {
      this.logger.warn(
        `Could not refresh live status for workflow run '${id}' (workflow '${run.workflowId}'): ${(error as Error).message}`,
      );
    }

    return this.toResult(run, liveStatus);
  }

  /**
   * Polling-on-the-server, deliberately not a MongoDB change stream — see `QaService.streamAnswer`'s
   * identical rejected-alternative note.
   *
   * Two independent named events on one connection: `run` (this row) and `approvals` (this run's
   * own pending approval, if any — scoped by `workflowId` via `ApprovalsService.peekPending`'s
   * optional third argument, not the tenant's whole pending-approval inbox). Scoping server-side,
   * rather than shipping the whole inbox for `WorkflowRunPage` to match by `workflowId`
   * client-side the way it used to, is what closes two things at once: the pagination divergence
   * this stream used to have from nowhere (an inbox has no "page" of its own to disagree about),
   * and the wider exposure of naming any run id to see every pending approval in the tenant. A run
   * whose `workflowId` cannot be resolved (a pre-D3 row minted before the field was threaded
   * through — see `ApprovalsService.decide`'s identical note) falls back to the unscoped inbox,
   * since there is no better key to filter by. `run$` and `approvals$` tick on independent timers —
   * nothing here audits per tick (`peekRun`/`ApprovalsService.peekPending` don't), so there is no
   * cost to reading them on separate schedules.
   */
  streamRun(id: string, actorId: string, tenantId: string): Observable<MessageEvent> {
    // Resolved once, lazily, and shared between the opening audit gate and `approvals$`'s scoping
    // below — both need this run's existence-checked row, but only `workflowId` matters to
    // `approvals$`, and that field is fixed at creation, so re-reading it every tick would be
    // wasted work. A plain memoized `Promise`, not a multicast RxJS operator: `concat(opened$,
    // merge(...))` further down already sequences `opened$` to resolve first, so by the time
    // `approvals$` subscribes the promise is already settled and this just returns its cached value.
    let initialRunPromise: Promise<WorkflowRunResult> | undefined;
    const getInitialRun = (): Promise<WorkflowRunResult> => {
      initialRunPromise ??= this.peekRun(id, tenantId);
      return initialRunPromise;
    };

    // At most one audit row per `SSE_STREAM_VIEW_AUDIT_DEDUPE_WINDOW_MS` per (actor, run) pair, not
    // one per stream OPEN — see `QaService.streamAnswer`'s identical `shouldRecordStreamView` use
    // for why. The initial peek here still gates the write on existence — matching `findById`'s own
    // audit-after-confirmation order.
    const opened$ = defer(getInitialRun).pipe(
      concatMap((run) => {
        if (
          !shouldRecordStreamView(
            `workflow-runs.viewed:${actorId}:${run.id}`,
            SSE_STREAM_VIEW_AUDIT_DEDUPE_WINDOW_MS,
          )
        ) {
          return of(undefined);
        }
        return this.auditService.record({
          action: 'workflow-runs.viewed',
          actorId,
          subject: { entityType: 'WorkflowRun', entityId: run.id },
          tenantId,
        });
      }),
      ignoreElements(),
    );

    const run$: Observable<WorkflowRunStreamEvent> = timer(0, WORKFLOW_RUN_STREAM_INTERVAL_MS).pipe(
      concatMap(() => this.peekRun(id, tenantId)),
      map((run) => toResponseDto(WorkflowRunResponseDto, run)),
      // Fresh DTO instance every tick, so comparing serialized JSON (not object identity) is what
      // actually suppresses a re-emit when nothing changed between polls.
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      map((data): WorkflowRunStreamEvent => ({ type: 'run', data })),
    );

    const approvals$: Observable<WorkflowRunStreamEvent> = defer(getInitialRun).pipe(
      concatMap((run) =>
        timer(0, WORKFLOW_RUN_STREAM_INTERVAL_MS).pipe(
          concatMap(() =>
            this.approvalsService.peekPending(
              { skip: DEFAULT_PAGINATION_SKIP, limit: DEFAULT_PAGINATION_LIMIT },
              tenantId,
              run.workflowId,
            ),
          ),
          map(({ docs, count }) => ({
            docs: docs.map((doc) => toResponseDto(ApprovalResponseDto, doc)),
            count,
          })),
          distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
          map((data): WorkflowRunStreamEvent => ({ type: 'approvals', data })),
        ),
      ),
    );

    const heartbeat$: Observable<WorkflowRunStreamEvent> = timer(
      SSE_HEARTBEAT_INTERVAL_MS,
      SSE_HEARTBEAT_INTERVAL_MS,
    ).pipe(map((): WorkflowRunStreamEvent => ({ type: 'heartbeat', data: {} })));

    return concat(opened$, merge(run$, approvals$, heartbeat$)).pipe(
      // Re-checked on every `SSE_REAUTH_INTERVAL_MS` tick, independent of the run/approvals/
      // heartbeat cadences above — see `QaService.streamAnswer`'s identical `takeUntil` for why
      // the initial `@CurrentUser()` check at subscribe time is not enough on its own, and
      // `reauthTicks$`'s own doc comment for why a `reload` failure also ends the stream.
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
      // Inclusive, and evaluated on the MERGED stream (not just `run$`) so completing here also
      // tears down the independent `approvals$` and heartbeat$ timers — see
      // `QaService.streamAnswer`'s identical reasoning for why a per-branch takeWhile would leave
      // them running forever.
      takeWhile(
        (event) => !(event.type === 'run' && isTerminalWorkflowRunStatus(event.data.status)),
        true,
      ),
      map((event): MessageEvent => event),
      // FAIL OPEN TO POLLING — see `QaService.streamAnswer`'s identical reasoning: the SPA's
      // retained `getWorkflowRunById`/`listApprovals()` polling is the fallback. The event carries
      // a fixed client-facing message, not `(error as Error).message` — see
      // `SSE_STREAM_ERROR_MESSAGE`'s doc comment; the real error is logged here instead.
      catchError((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`streamRun failed for run '${id}': ${message}`);
        return of<MessageEvent>({ type: 'error', data: { message: SSE_STREAM_ERROR_MESSAGE } });
      }),
    );
  }

  /**
   * Tenant-scoped listing, optionally filtered by Temporal `workflowId` — the SPA's only way to
   * link an `ApprovalResponseDto` (which exposes `workflowId`, not the Mongo `_id`) to its run
   * timeline. Omitting `workflowId` lists every run for the tenant, most recent first, which is
   * how a caller who navigated away from a run without keeping its id finds it again. Deliberately
   * does not refresh against the live engine the way `findById` does: a caller lands here to find
   * the `_id` to link to, then immediately follows with `GET /workflow-runs/:id`, which already
   * does the best-effort refresh — refreshing twice would be a redundant Temporal round-trip for a
   * listing view.
   */
  async listByWorkflowId(
    dto: ListWorkflowRunsRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<WorkflowRunResult>> {
    const filter = { tenantId, ...(dto.workflowId ? { workflowId: dto.workflowId } : {}) };

    const [runs, count] = await Promise.all([
      this.workflowRunModel.find(filter, null, {
        sort: { createdAt: -1 },
        skip: dto.skip,
        limit: dto.limit,
      }),
      this.workflowRunModel.countDocuments(filter),
    ]);

    await this.auditService.record({
      action: 'workflow-runs.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return { docs: runs.map((run) => this.toResult(run)), count };
  }

  /**
   * Tenant-scoped, audit-free lookup of the durable row by Temporal `workflowId` — reused by
   * `SourcesService.requestSync` to resurface the run projection for an already-running sync loop
   * without minting a second `workflow-runs.listed` audit row for what is, from the caller's
   * perspective, still a single `sources.sync_requested` action. Returns `null` on a miss rather
   * than throwing: an absent row here means a source's `syncWorkflowId` outlived the projection
   * that named it, which the caller is better placed to turn into a specific error than this
   * generic lookup is.
   */
  async findRunByWorkflowId(
    workflowId: string,
    tenantId: string,
  ): Promise<WorkflowRunResult | null> {
    const run = await this.workflowRunModel.findOne({ workflowId, tenantId });
    return run ? this.toResult(run) : null;
  }

  private toResult(
    run: WorkflowRunDocument,
    statusOverride?: WorkflowRunStatus,
  ): WorkflowRunResult {
    return {
      id: run._id.toString(),
      workflowId: run.workflowId,
      workflowType: run.workflowType,
      status: statusOverride ?? run.status,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt,
    };
  }
}
