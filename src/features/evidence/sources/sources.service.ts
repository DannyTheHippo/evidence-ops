import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { Model, Types } from 'mongoose';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import type { DocumentSourceClass } from '../../../database/schemas/evidence/document/document.schema';
import {
  Source,
  SourceDocument,
  type SourceConnectivity,
  type SourceFileState,
  type SourceKind,
  type SourceReachability,
} from '../../../database/schemas/evidence/source/source.schema';
import {
  SOURCE_CONNECTOR,
  type SourceConnector,
  type SourceConnectorFile,
} from '../../../providers/source-connector/source-connector.interface';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../providers/workflow-engine/workflow-engine.interface';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import type { SyncSourceWorkflowInput } from '../../../workflows/types';
import { MAX_FILE_SIZE_BYTES, resolveUploadKind } from '../documents/documents.constant';
import { DocumentsService } from '../documents/documents.service';
import type { UploadedFileLike } from '../documents/types/uploaded-file.type';
import type { WorkflowRunResult } from '../workflow-runs/workflow-runs.service';
import { WorkflowRunsService } from '../workflow-runs/workflow-runs.service';
import type { SourceFileStateStatus } from './dtos/response/source-file-state.response.dto';
import type { ListSourcesRequestDto } from './dtos/request/list-sources.request.dto';
import {
  SourceNameConflictException,
  SourceNotFoundException,
} from './exceptions/sources.exception';

export interface CreateSourceInput {
  readonly name: string;
  readonly kind: SourceKind;
  readonly path: string;
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly connectivity?: SourceConnectivity;
  readonly reachability?: SourceReachability;
  readonly owner: string;
  readonly tracked?: boolean;
  readonly sourceClass?: DocumentSourceClass;
  readonly actorId: string;
  readonly tenantId: string;
}

/** `SourcesService.update`'s input — every field optional and independently applied; see that
 *  method's own doc comment. */
export interface UpdateSourceInput {
  readonly enabled?: boolean;
  readonly connectivity?: SourceConnectivity;
  readonly reachability?: SourceReachability;
  readonly owner?: string;
  readonly tracked?: boolean;
  readonly sourceClass?: DocumentSourceClass;
}

export interface SourceResult {
  readonly id: string;
  readonly name: string;
  readonly kind: SourceKind;
  readonly path: string;
  readonly enabled: boolean;
  readonly intervalMs?: number;
  readonly syncWorkflowId?: string;
  readonly lastSyncAt?: Date;
  readonly lastSyncStatus?: string;
  readonly lastSyncError?: string;
  readonly fileCount: number;
  readonly connectivity: SourceConnectivity;
  readonly reachability: SourceReachability;
  readonly owner?: string;
  readonly tracked: boolean;
  readonly sourceClass: DocumentSourceClass;
  readonly createdAt: Date;
}

export interface SourceFileStateResult {
  readonly path: string;
  readonly status: SourceFileStateStatus;
  readonly lastError?: string;
  readonly mtimeMs: number;
}

export interface SourceWithFileStatesResult extends SourceResult {
  readonly fileStates: SourceFileStateResult[];
}

/** `previousClass` absent means `sourceClass` has never changed for this source, so `count` is
 *  always `0` in that state — see `Source.previousSourceClass`'s own doc comment. */
export interface SourceClassDriftResult {
  readonly previousClass?: DocumentSourceClass;
  readonly count: number;
}

/** `previousClass` echoes what this apply reconciled against — absent when there was nothing to
 *  reconcile, in which case `modifiedCount` is always `0`. */
export interface ApplySourceClassDriftResult {
  readonly modifiedCount: number;
  readonly previousClass?: DocumentSourceClass;
  readonly sourceClass: DocumentSourceClass;
}

/** Return of `runSync`. `disabled: true` means the source's own `enabled` flag was off (or the
 *  source no longer exists) and the sync loop must stop; `intervalMs: null` means either a
 *  one-shot sync or that this attempt's lease was lost to a newer attempt (see `runSync`'s own doc
 *  comment) — both end the workflow's loop without claiming the source itself is disabled. Kept as
 *  a separate type rather than imported so this service never depends on the determinism-fenced
 *  `workflows/**` directory for a runtime type. */
export interface RunSyncResult {
  readonly disabled: boolean;
  readonly intervalMs: number | null;
}

/**
 * `syncSource` — the Temporal workflow type name in `src/workflows/sync-source.workflow.ts` — is
 * not exported as a runtime value from `src/workflows/**` (see `documents.service.ts`'s identical
 * `INGEST_DOCUMENT_VERSION_WORKFLOW_TYPE` comment for why it is duplicated here rather than
 * imported).
 */
const SYNC_SOURCE_WORKFLOW_TYPE = 'syncSource';

@Injectable()
export class SourcesService {
  constructor(
    @InjectModel(Source.name)
    private readonly sourceModel: Model<SourceDocument>,

    @Inject(SOURCE_CONNECTOR)
    private readonly sourceConnector: SourceConnector,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly workflowRunsService: WorkflowRunsService,
    private readonly documentsService: DocumentsService,
    private readonly config: TypedConfigService,
    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(SourcesService.name);
  }

  /** Maps the unique `{tenantId, name}` index (`migrations/0014-sources-indexes.ts`) onto a 409 —
   *  the application-layer surface for a race the index itself already prevents at the driver
   *  level. */
  async create(input: CreateSourceInput): Promise<SourceResult> {
    const tenantId = input.tenantId;

    let source: SourceDocument;
    try {
      source = await this.sourceModel.create({
        name: input.name,
        kind: input.kind,
        path: input.path,
        enabled: input.enabled ?? true,
        intervalMs: input.intervalMs,
        connectivity: input.connectivity ?? 'connector',
        reachability: input.reachability ?? 'live',
        owner: input.owner,
        tracked: input.tracked ?? true,
        sourceClass: input.sourceClass ?? 'unclassified',
        tenantId,
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new SourceNameConflictException(
          `A source named '${input.name}' already exists for this tenant`,
          error,
        );
      }
      throw error;
    }

    await this.auditService.record({
      action: 'sources.created',
      actorId: input.actorId,
      subject: { entityType: 'Source', entityId: source._id.toString() },
      tenantId,
    });

    return this.toResult(source);
  }

  async list(
    dto: ListSourcesRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<SourceResult>> {
    const filter = {
      tenantId,
      ...(dto.lastSyncStatus !== undefined ? { lastSyncStatus: dto.lastSyncStatus } : {}),
      ...(dto.tracked !== undefined ? { tracked: dto.tracked } : {}),
    };

    const [sources, count] = await Promise.all([
      this.sourceModel.find(filter, null, {
        sort: { createdAt: -1 },
        skip: dto.skip,
        limit: dto.limit,
      }),
      this.sourceModel.countDocuments(filter),
    ]);

    await this.auditService.record({
      action: 'sources.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return { docs: sources.map((source) => this.toResult(source)), count };
  }

  async getById(
    id: string,
    actorId: string,
    tenantId: string,
  ): Promise<SourceWithFileStatesResult> {
    const source = await this.findOwnedSource(id, tenantId);

    await this.auditService.record({
      action: 'sources.viewed',
      actorId,
      subject: { entityType: 'Source', entityId: id },
      tenantId,
    });

    return this.toResultWithFileStates(source);
  }

  /**
   * Partial update — only fields present on `input` are touched, generalizing `setEnabled`'s old
   * single-field `$set` to every field the inventory form can change. `name`/`kind`/`path` are not
   * accepted here: repointing or renaming a source is a `create` decision, not an edit.
   */
  async update(
    id: string,
    input: UpdateSourceInput,
    actorId: string,
    tenantId: string,
  ): Promise<SourceResult> {
    const existing = await this.findOwnedSource(id, tenantId);

    const $set: Partial<Record<keyof UpdateSourceInput, unknown>> & {
      previousSourceClass?: DocumentSourceClass;
    } = {};
    if (input.enabled !== undefined) $set.enabled = input.enabled;
    if (input.connectivity !== undefined) $set.connectivity = input.connectivity;
    if (input.reachability !== undefined) $set.reachability = input.reachability;
    if (input.owner !== undefined) $set.owner = input.owner;
    if (input.tracked !== undefined) $set.tracked = input.tracked;
    // Stamps `previousSourceClass` only on a genuine change, never on a re-set to the same value —
    // see that field's own doc comment for why a no-op set must leave it untouched.
    if (input.sourceClass !== undefined) {
      $set.sourceClass = input.sourceClass;
      if (input.sourceClass !== existing.sourceClass) {
        $set.previousSourceClass = existing.sourceClass;
      }
    }

    const source = await this.sourceModel.findOneAndUpdate(
      { _id: id, tenantId },
      { $set },
      { new: true },
    );
    if (!source) {
      throw new SourceNotFoundException(`Source '${id}' not found`);
    }

    await this.auditService.record({
      action: 'sources.updated',
      actorId,
      subject: { entityType: 'Source', entityId: id },
      tenantId,
    });

    return this.toResult(source);
  }

  /**
   * Reports how many documents ingested from this source still carry `previousSourceClass`
   * instead of the source's current `sourceClass` — the correction never rewrites already-ingested
   * documents on its own (`update`'s own doc comment), so this is what makes that drift visible
   * rather than silent. Audited the same as `getById`: a read of one source's detail.
   */
  async getClassDriftReport(
    id: string,
    actorId: string,
    tenantId: string,
  ): Promise<SourceClassDriftResult> {
    const source = await this.findOwnedSource(id, tenantId);

    await this.auditService.record({
      action: 'sources.class_drift_viewed',
      actorId,
      subject: { entityType: 'Source', entityId: id },
      tenantId,
    });

    if (!source.previousSourceClass) {
      return { previousClass: undefined, count: 0 };
    }

    const count = await this.documentsService.countBySourceAndClass(
      source._id,
      source.previousSourceClass,
      tenantId,
    );

    return { previousClass: source.previousSourceClass, count };
  }

  /**
   * Applies this source's current `sourceClass` to exactly the documents `getClassDriftReport`
   * counts — recomputed fresh against `previousSourceClass` at this moment, not against whatever
   * count a caller read earlier, so a sync landing in between is reconciled too rather than
   * silently under- or over-applied. A no-op (`modifiedCount: 0`) when this source has never had
   * `sourceClass` changed, rather than an error — nothing to reconcile is not a caller mistake.
   */
  async applyClassDrift(
    id: string,
    actorId: string,
    tenantId: string,
  ): Promise<ApplySourceClassDriftResult> {
    const source = await this.findOwnedSource(id, tenantId);

    const modifiedCount = source.previousSourceClass
      ? await this.documentsService.applySourceClassToDrifted(
          source._id,
          source.previousSourceClass,
          source.sourceClass,
          tenantId,
        )
      : 0;

    await this.auditService.record({
      action: 'sources.class_drift_applied',
      actorId,
      subject: { entityType: 'Source', entityId: id },
      tenantId,
      modifiedCount,
    });

    return {
      modifiedCount,
      previousClass: source.previousSourceClass,
      sourceClass: source.sourceClass,
    };
  }

  /**
   * Starts the `syncSource` workflow loop for one source, recording the durable `WorkflowRun`
   * projection the same way `ConflictsService.requestResolution` does for its own workflow. The
   * duplicate-loop guard is `Source.syncWorkflowId`: a source that already names a `running`
   * execution never gets a second one started underneath it. `WorkflowEngine.status` FAILS OPEN to
   * "not running" on a lookup failure (a stale handle, an engine hiccup) — same posture
   * `WorkflowRunsService.peekRun` takes for the identical call, and safe here because the sync
   * activity's own lease CAS (`runSync`) is the backstop against two loops actually racing writes.
   *
   * Returns the `WorkflowRun` projection either way: the row just created when a new loop starts,
   * or the existing row named by `Source.syncWorkflowId` when a loop is already running — a caller
   * polls the same shape regardless of which branch fired. A miss on that second lookup means the
   * source's `syncWorkflowId` outlived the projection it names, which is data corruption rather
   * than a client error.
   */
  async requestSync(id: string, actorId: string, tenantId: string): Promise<WorkflowRunResult> {
    const source = await this.findOwnedSource(id, tenantId);

    let run: WorkflowRunResult | null;
    if (source.syncWorkflowId && (await this.isWorkflowRunning(source.syncWorkflowId))) {
      this.logger.debug(
        `Source '${id}' already has a running sync workflow '${source.syncWorkflowId}'; not starting a second one`,
      );
      run = await this.workflowRunsService.findRunByWorkflowId(source.syncWorkflowId, tenantId);
    } else {
      const handle = await this.workflowEngine.start(SYNC_SOURCE_WORKFLOW_TYPE, {
        sourceId: id,
      } satisfies SyncSourceWorkflowInput);

      source.syncWorkflowId = handle.id;
      await source.save();

      run = await this.workflowRunsService.create({
        workflowId: handle.id,
        workflowType: 'sync-source',
        status: handle.status,
        tenantId,
      });

      this.logger.debug(`Started syncSource workflow '${handle.id}' for source '${id}'`);
    }

    if (!run) {
      throw new InternalServerErrorException(
        `Source '${id}' names sync workflow '${source.syncWorkflowId}' with no WorkflowRun row`,
      );
    }

    await this.auditService.record({
      action: 'sources.sync_requested',
      actorId,
      subject: { entityType: 'Source', entityId: id },
      tenantId,
    });

    return run;
  }

  /**
   * The `runSourceSync` activity's entrypoint (`src/worker/activities.ts`), called once per
   * workflow loop iteration with a fresh `leaseToken` minted activity-side — a token threaded
   * through the workflow itself would be identical on every Temporal retry of the same activity
   * call and could never distinguish a stale attempt from a newer one (the same reasoning
   * `IngestionService.ingestVersion` documents for its own per-attempt token).
   *
   * Mirrors `IngestionService.ingestVersion`'s two-part lease discipline exactly, adapted for a
   * recurring loop rather than a once-and-done job: `claimAttempt` unconditionally stamps
   * `syncLeaseToken` (sources have no terminal status to guard the claim itself against, unlike
   * `ingestionStatus`), and the loss check that matters — "did a newer attempt claim this source
   * while I was working" — happens at `finalizeSync`, scoped by `{_id, syncLeaseToken: leaseToken}`
   * exactly like `finalizeCompletion`/`finalizeFailure`. A lost finalize discards this attempt's
   * results and returns `intervalMs: null` so this stale execution's loop exits without claiming
   * the source itself is disabled — see `RunSyncResult`'s own doc comment.
   */
  async runSync(sourceId: string, leaseToken: Types.ObjectId): Promise<RunSyncResult> {
    const source = await this.claimAttempt(new Types.ObjectId(sourceId), leaseToken);
    if (!source) {
      this.logger.debug(`Source '${sourceId}' no longer exists; sync loop exiting`);
      return { disabled: true, intervalMs: null };
    }

    if (!source.enabled) {
      this.logger.debug(`Source '${sourceId}' disabled; sync loop exiting`);
      return { disabled: true, intervalMs: null };
    }

    // Fails CLOSED: an inventory-only row is catalogued for the estate map, never handed to a
    // connector — this recurring loop must never sync it, no matter how it was started.
    if (!source.tracked) {
      this.logger.debug(`Source '${sourceId}' not tracked; sync loop exiting`);
      return { disabled: true, intervalMs: null };
    }

    const intervalMs = source.intervalMs ?? this.config.sources.syncIntervalMs;

    let files: SourceConnectorFile[];
    try {
      files = await this.sourceConnector.listFiles(source.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finalizeSync(source._id, leaseToken, source.fileStates, 'failed', message);
      this.logger.warn(`Source '${sourceId}' sync failed listing files: ${message}`);
      return { disabled: false, intervalMs };
    }

    const fileStates = [...source.fileStates];
    for (const file of files) {
      await this.syncOneFile(file, fileStates, source.tenantId, source.sourceClass, source._id);
    }

    const finalized = await this.finalizeSync(source._id, leaseToken, fileStates, 'ok');
    if (!finalized) {
      this.logger.debug(
        `Source '${sourceId}' sync superseded by a newer attempt; discarding results`,
      );
      return { disabled: false, intervalMs: null };
    }

    return { disabled: false, intervalMs };
  }

  /**
   * `tenantId` lookup by `_id` alone, for the `runSourceSync` activity (`src/worker/activities.ts`)
   * to open the tenant's ALS scope before calling `runSync` — `SyncSourceWorkflowInput` carries
   * only `sourceId`, so the activity has no tenant to scope with until this resolves one.
   * Unscoped and unaudited, mirroring `claimAttempt`'s own `{_id}`-only lookup: this exists only to
   * name a tenant, not to authorize anything. Absent (`undefined`) covers both an invalid id and a
   * source that no longer exists — the same case `runSync` itself handles by exiting the loop.
   */
  async findTenantIdForSync(id: string): Promise<string | undefined> {
    if (!Types.ObjectId.isValid(id)) {
      return undefined;
    }
    const source = await this.sourceModel.findById(id, { tenantId: 1 });
    return source?.tenantId;
  }

  /**
   * Syncs one discovered file against `fileStates` (mutated in place — `runSync` persists the
   * whole array once, after every file in the sweep has been visited). Failure direction: FAILS
   * OPEN per file — every error below (fetch, either size check, an unresolvable kind, or the
   * `DocumentsService.upload` call itself) is caught here and recorded rather than aborting the
   * sweep, so one bad file never blocks its siblings.
   *
   * The size cap is enforced twice, not once: `file.sizeBytes` (the connector's `listFiles` stat,
   * taken before this call) rejects an oversized file before `fetchFile` ever reads it into
   * memory — load-bearing on a path whose entire purpose is consuming files nobody handed this
   * process directly, where an unbounded read driven by whatever is on disk is unacceptable. The
   * post-fetch `content.length` check stays too: `file.sizeBytes` is a stat reading that can be
   * stale by the time `fetchFile` runs (the file can grow between list and fetch), so it is the
   * cheap guard, never a replacement for the authoritative check against the bytes actually read.
   *
   * A brand-new file that fails has no prior `fileStates` entry to attach `lastError` to, and
   * `SourceFileState.documentId` is required — there is nothing to persist a partial entry against,
   * so that case is logged only, not recorded on the source. It is retried on every future sync
   * (no entry means "new" again) until it succeeds or the underlying file is fixed. An existing
   * entry that fails keeps its previous watermark (`sizeBytes`/`mtimeMs`/`sha256`/`documentId`)
   * unchanged alongside the new `lastError` — advancing the watermark on a failed attempt would make
   * the cheap watermark check above skip the file forever without it ever having synced.
   */
  private async syncOneFile(
    file: SourceConnectorFile,
    fileStates: SourceFileState[],
    tenantId: string,
    sourceClass: DocumentSourceClass,
    sourceId: Types.ObjectId,
  ): Promise<void> {
    const index = fileStates.findIndex((state) => state.path === file.relativePath);
    const existing = index === -1 ? undefined : fileStates[index];

    if (existing && existing.sizeBytes === file.sizeBytes && existing.mtimeMs === file.mtimeMs) {
      return;
    }

    try {
      if (file.sizeBytes > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `'${file.relativePath}' is ${file.sizeBytes} bytes, over the ${MAX_FILE_SIZE_BYTES}-byte sync limit`,
        );
      }

      const content = await this.sourceConnector.fetchFile(file.relativePath);

      if (content.length > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `'${file.relativePath}' is ${content.length} bytes, over the ${MAX_FILE_SIZE_BYTES}-byte sync limit`,
        );
      }

      const filename = basename(file.relativePath);
      /** `mimetype: ''` forces resolution through the ambiguous-MIME/extension path
       * (`resolveUploadKind`'s own doc comment) — a filesystem connector has no browser-supplied
       * MIME to trust, only the filename. */
      if (!resolveUploadKind('', filename)) {
        throw new Error(`Could not resolve a document type for '${file.relativePath}'`);
      }

      const sha256 = createHash('sha256').update(content).digest('hex');

      if (existing && existing.sha256 === sha256) {
        fileStates[index] = {
          ...existing,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
          lastError: undefined,
        };
        return;
      }

      const uploadedFile: UploadedFileLike = {
        originalname: filename,
        mimetype: '',
        size: content.length,
        buffer: content,
      };

      // `sourceClass`/`sourceId` only matter on the document-creation branch below — `addVersion`
      // (existing branch) writes bytes onto a document that already has both, unrelated to this
      // sync attempt's source.
      const response = existing
        ? await this.documentsService.upload(
            uploadedFile,
            { documentId: existing.documentId.toString() },
            tenantId,
          )
        : await this.documentsService.upload(uploadedFile, { title: filename }, tenantId, {
            sourceClass,
            sourceId,
          });

      const newState: SourceFileState = {
        path: file.relativePath,
        sha256,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        documentId: new Types.ObjectId(response.id),
      };
      if (existing) {
        fileStates[index] = newState;
      } else {
        fileStates.push(newState);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (existing) {
        fileStates[index] = { ...existing, lastError: message };
      } else {
        this.logger.warn(`Sync error for new file '${file.relativePath}': ${message}`);
      }
    }
  }

  private async isWorkflowRunning(workflowId: string): Promise<boolean> {
    try {
      const handle = await this.workflowEngine.status(workflowId);
      return handle.status === 'running';
    } catch {
      return false;
    }
  }

  private async claimAttempt(
    sourceId: Types.ObjectId,
    leaseToken: Types.ObjectId,
  ): Promise<SourceDocument | null> {
    return this.sourceModel.findOneAndUpdate(
      { _id: sourceId },
      { $set: { syncLeaseToken: leaseToken } },
    );
  }

  /** Fails CLOSED: only succeeds while `leaseToken` is still the current one, mirroring
   *  `IngestionService.finalizeCompletion`/`finalizeFailure` exactly — see `runSync`'s own doc
   *  comment for why the loss check lives here rather than at `claimAttempt`. */
  private async finalizeSync(
    sourceId: Types.ObjectId,
    leaseToken: Types.ObjectId,
    fileStates: SourceFileState[],
    status: 'ok' | 'failed',
    errorMessage?: string,
  ): Promise<boolean> {
    const finalized = await this.sourceModel.findOneAndUpdate(
      { _id: sourceId, syncLeaseToken: leaseToken },
      status === 'ok'
        ? {
            $set: { fileStates, lastSyncAt: new Date(), lastSyncStatus: status },
            $unset: { lastSyncError: '' },
          }
        : {
            $set: {
              fileStates,
              lastSyncAt: new Date(),
              lastSyncStatus: status,
              lastSyncError: errorMessage,
            },
          },
    );
    return finalized !== null;
  }

  /** Cross-tenant id must be indistinguishable from a missing one — same `findOne` + tenant
   *  predicate pattern every other tenant-scoped lookup in this codebase uses. */
  private async findOwnedSource(id: string, tenantId: string): Promise<SourceDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new SourceNotFoundException(`Source '${id}' not found`);
    }

    const source = await this.sourceModel.findOne({ _id: id, tenantId });
    if (!source) {
      throw new SourceNotFoundException(`Source '${id}' not found`);
    }

    return source;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000
    );
  }

  private toResult(source: SourceDocument): SourceResult {
    return {
      id: source._id.toString(),
      name: source.name,
      kind: source.kind,
      path: source.path,
      enabled: source.enabled,
      intervalMs: source.intervalMs,
      syncWorkflowId: source.syncWorkflowId,
      lastSyncAt: source.lastSyncAt,
      lastSyncStatus: source.lastSyncStatus,
      lastSyncError: source.lastSyncError,
      fileCount: source.fileStates.length,
      connectivity: source.connectivity,
      reachability: source.reachability,
      owner: source.owner,
      tracked: source.tracked,
      sourceClass: source.sourceClass,
      createdAt: source.createdAt,
    };
  }

  private toResultWithFileStates(source: SourceDocument): SourceWithFileStatesResult {
    return {
      ...this.toResult(source),
      fileStates: source.fileStates.map((state) => ({
        path: state.path,
        status: state.lastError ? 'failed' : 'ok',
        lastError: state.lastError,
        mtimeMs: state.mtimeMs,
      })),
    };
  }
}
