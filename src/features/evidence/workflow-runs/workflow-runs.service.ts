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
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import { reauthTicks$, shouldRecordStreamView } from '../../../shared/utils/stream-session.util';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { ApprovalsService } from '../approvals/approvals.service';
import { ApprovalResponseDto } from '../approvals/dtos/response/approval.response.dto';
import {
  DEFAULT_WORKFLOW_RUN_SORT_DIRECTION,
  DEFAULT_WORKFLOW_RUN_SORT_FIELD,
  type ListWorkflowRunsRequestDto,
} from './dtos/request/list-workflow-runs.request.dto';
import { WorkflowRunResponseDto } from './dtos/response/workflow-run.response.dto';
import { WorkflowRunNotFoundException } from './exceptions/workflow-runs.exception';
import {
  WORKFLOW_RUN_ENGINE_STATUS_CACHE_MS,
  WORKFLOW_RUN_STREAM_INTERVAL_MS,
} from './workflow-runs.constant';

export interface CreateWorkflowRunInput {
  readonly workflowId: string;
  readonly workflowType: WorkflowRunType;
  readonly status: WorkflowRunStatus;
  readonly tenantId?: string;
  /** Identifies the entity this run acts on — e.g. the `Conflict` a `resolve-conflict` run gates.
   *  Read alongside `subjectType`; a caller passing one without the other leaves both unset (see
   *  `create`'s own doc comment). */
  readonly subjectId?: string;
  readonly subjectType?: string;
}

export interface WorkflowRunResult {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowType?: WorkflowRunType;
  readonly status: WorkflowRunStatus;
  readonly errorMessage?: string;
  readonly subjectId?: string;
  readonly subjectType?: string;
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
  // Keyed by Temporal `workflowId`, shared across every concurrent `peekRun` caller — see
  // `getLiveStatus`'s own doc comment. `getLiveStatus` sweeps every expired entry before each
  // lookup, so this stays bounded to runs within their current cache window rather than
  // accumulating one entry per workflowId the process has ever polled.
  private readonly liveStatusCache = new Map<
    string,
    { readonly expiresAt: number; readonly statusPromise: Promise<WorkflowRunStatus | undefined> }
  >();

  constructor(
    @InjectModel(WorkflowRun.name)
    private readonly workflowRunModel: Model<WorkflowRunDocument>,

    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly approvalsService: ApprovalsService,
    private readonly config: TypedConfigService,
    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(WorkflowRunsService.name);
  }

  /**
   * Creates the durable projection a caller who just started a workflow hands back, so a client
   * has an id to poll `GET /workflow-runs/:id` with. Two callers write here:
   * `ConflictsService.requestResolution` (which passes `subjectId`/`subjectType` naming the
   * `Conflict` being gated) and `SourcesService.requestSync` (which passes neither) —
   * `answer-question` and `ingest-document-version` run without a projection, so no run row
   * exists for them either way.
   */
  async create(input: CreateWorkflowRunInput): Promise<WorkflowRunResult> {
    // Written together or not at all, matching the schema field's own invariant (see
    // `WorkflowRun.subjectId`'s doc comment) — a caller naming only one of the pair leaves both
    // unset rather than persisting a `subjectType` with no `subjectId` to pair it with, or vice
    // versa.
    const subject =
      input.subjectId !== undefined && input.subjectType !== undefined
        ? { subjectId: new Types.ObjectId(input.subjectId), subjectType: input.subjectType }
        : {};

    const run = await this.workflowRunModel.create({
      workflowId: input.workflowId,
      workflowType: input.workflowType,
      status: input.status,
      tenantId: input.tenantId,
      ...subject,
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

    const liveStatus = await this.getLiveStatus(run.workflowId, id);

    return this.toResult(run, liveStatus ?? run.status);
  }

  /**
   * Throttled, coalesced front for `WorkflowEngine.status()`. Evicts every `liveStatusCache` entry
   * that has already expired before looking `workflowId` up — mirrors `McpServerService
   * .applyFixedWindow`'s identical sweep-before-lookup shape for the same reason: a map keyed by a
   * high-cardinality identity (here, every workflow run ever polled) must stay bounded to entries
   * within their current window rather than accumulating one per key the process has ever seen. A
   * cache hit returns the in-flight or already-settled call for this `workflowId` without touching
   * the engine again; a miss issues one new call and caches it — resolved or rejected — for
   * `WORKFLOW_RUN_ENGINE_STATUS_CACHE_MS`, so every concurrent `peekRun` caller for the same run
   * (parallel `streamRun` ticks, parallel open tabs, a `findById` landing mid-window) shares that
   * one call instead of each issuing its own. FAILS OPEN on the engine call, same direction as
   * `peekRun`'s own doc comment: `undefined` tells the caller to fall back to the durable row's
   * status rather than surfacing an error, and the failure is logged once per cache window rather
   * than once per caller.
   */
  private getLiveStatus(workflowId: string, runId: string): Promise<WorkflowRunStatus | undefined> {
    const now = Date.now();
    for (const [cachedWorkflowId, entry] of this.liveStatusCache) {
      if (entry.expiresAt <= now) {
        this.liveStatusCache.delete(cachedWorkflowId);
      }
    }

    const cached = this.liveStatusCache.get(workflowId);
    if (cached) {
      return cached.statusPromise;
    }

    const statusPromise = this.workflowEngine
      .status(workflowId)
      .then((handle) => handle.status)
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not refresh live status for workflow run '${runId}' (workflow '${workflowId}'): ${(error as Error).message}`,
        );
        return undefined;
      });

    this.liveStatusCache.set(workflowId, {
      expiresAt: now + WORKFLOW_RUN_ENGINE_STATUS_CACHE_MS,
      statusPromise,
    });

    return statusPromise;
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
      // Absolute ceiling on a single connection, independent of every other terminal condition
      // here: a run wedged short of a terminal status, and a client that never disconnects, would
      // otherwise hold one of the user's `SSE_MAX_CONNECTIONS_PER_USER` slots for as long as the
      // process lives — past the session cookie's own expiry.
      takeUntil(timer(this.config.sse.maxStreamLifetimeMs)),
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
   * Tenant-scoped listing, optionally filtered by Temporal `workflowId`, `status`, and
   * `workflowType` — `workflowId` is the SPA's only way to link an `ApprovalResponseDto` (which
   * exposes `workflowId`, not the Mongo `_id`) to its run timeline. Omitting every filter lists
   * every run for the tenant, most recent first, which is how a caller who navigated away from a
   * run without keeping its id finds it again. Deliberately does not refresh against the live
   * engine the way `findById` does: a caller lands here to find the `_id` to link to, then
   * immediately follows with `GET /workflow-runs/:id`, which already does the best-effort refresh
   * — refreshing twice would be a redundant Temporal round-trip for a listing view. This also means
   * `status` filters against the durable row exactly as stored, not the live engine's current
   * state — a run can look stale here for as long as it goes between activity updates.
   */
  async listByWorkflowId(
    dto: ListWorkflowRunsRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<WorkflowRunResult>> {
    const filter = {
      tenantId,
      ...(dto.workflowId ? { workflowId: dto.workflowId } : {}),
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.workflowType ? { workflowType: dto.workflowType } : {}),
    };

    const [runs, count] = await Promise.all([
      this.workflowRunModel.find(filter, null, {
        sort: resolveSort(
          dto.sort,
          dto.sortDir,
          DEFAULT_WORKFLOW_RUN_SORT_FIELD,
          DEFAULT_WORKFLOW_RUN_SORT_DIRECTION,
        ),
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
      // `SourcesService.requestSync` writes no subject, so this pair stays undefined on a
      // `sync-source` row — only a writer that names one populates it.
      subjectId: run.subjectId?.toString(),
      subjectType: run.subjectId ? run.subjectType : undefined,
      createdAt: run.createdAt,
    };
  }
}
