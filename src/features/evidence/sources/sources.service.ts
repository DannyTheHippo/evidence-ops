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
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import type { SyncSourceWorkflowInput } from '../../../workflows/types';
import { MAX_FILE_SIZE_BYTES, resolveUploadKind } from '../documents/documents.constant';
import { DocumentsService } from '../documents/documents.service';
import type { UploadedFileLike } from '../documents/types/uploaded-file.type';
import type { WorkflowRunResult } from '../workflow-runs/workflow-runs.service';
import { WorkflowRunsService } from '../workflow-runs/workflow-runs.service';
import type { SourceFileStateStatus } from './dtos/response/source-file-state.response.dto';
import {
  DEFAULT_SOURCE_SORT_DIRECTION,
  DEFAULT_SOURCE_SORT_FIELD,
  type ListSourcesRequestDto,
} from './dtos/request/list-sources.request.dto';
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

/**
 * `runSync`'s absence-withdrawal guards, all failing toward retention — never environment
 * variables, since a wrong value here risks silently unretrievable evidence rather than a
 * misconfigured feature flag.
 *
 * G1 (empty listing): an unmounted mountpoint's `listFiles` returns `[]` *successfully* — only a
 * missing directory throws — so an empty fresh listing against known, non-empty state is
 * structurally indistinguishable from a genuinely emptied source. Accepted cost: an operator who
 * truly empties a source uses the admin delete path (`DocumentsService.remove`) instead.
 *
 * G2 (proportional circuit breaker): catches a partial mount G1 misses. More than this fraction of
 * the source's still-active (not yet withdrawn) known paths absent in one sweep suppresses
 * withdrawal for the whole sweep, rather than trusting a listing that is plausibly non-empty but
 * still wrong.
 *
 * G3 (two-strike): a path absent on a single sweep only increments `SourceFileState.absentSweeps`;
 * withdrawal fires once a path has been absent on this many consecutive sweeps. Closes the
 * write-temp-then-rename window a single-sweep absence would otherwise misread as deletion.
 *
 * When G1 or G2 fires, `absentSweeps` is left untouched on every entry — a distrusted listing must
 * not advance the counter, or the breaker merely delays the false positive by one sweep.
 */
const EMPTY_LISTING_SUPPRESSION_REASON = 'empty-listing';
const PROPORTIONAL_ABSENCE_THRESHOLD = 0.5;
const PROPORTIONAL_ABSENCE_SUPPRESSION_REASON = 'absence-threshold-exceeded';
const ABSENT_SWEEPS_BEFORE_WITHDRAWAL = 2;

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

  /** Maps the unique `{tenantId, name}` index (`migrations/0001-baseline.ts`) onto a 409 —
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
        sort: resolveSort(
          dto.sort,
          dto.sortDir,
          DEFAULT_SOURCE_SORT_FIELD,
          DEFAULT_SOURCE_SORT_DIRECTION,
        ),
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

    // Absence diff, computed against the entries the per-file loop above never touched —
    // `syncOneFile` only mutates a `fileStates` entry for a path present in `files`, so anything
    // still absent here genuinely wasn't in this sweep's fresh listing. Deliberately asymmetric
    // with `syncOneFile`'s uploads, which run before `finalizeSync`'s compare-and-set below: a
    // lost-lease attempt writing a duplicate version is harmless (content-addressed dedupe absorbs
    // it), whereas a lost-lease attempt making evidence unretrievable is not, and there is no
    // transaction to fall back on — so `DocumentsService.withdrawVersions` runs only after
    // `finalizeSync` confirms this attempt still owns the lease, never before.
    const freshPaths = new Set(files.map((file) => file.relativePath));
    const activeKnown = fileStates.filter((state) => state.withdrawnAt === undefined);
    const absentActive = activeKnown.filter((state) => !freshPaths.has(state.path));

    let withdrawalSuppressedReason: string | undefined;
    const documentIdsToWithdraw: Types.ObjectId[] = [];

    if (files.length === 0 && activeKnown.length > 0) {
      withdrawalSuppressedReason = EMPTY_LISTING_SUPPRESSION_REASON;
    } else if (
      activeKnown.length > 0 &&
      absentActive.length / activeKnown.length > PROPORTIONAL_ABSENCE_THRESHOLD
    ) {
      withdrawalSuppressedReason = PROPORTIONAL_ABSENCE_SUPPRESSION_REASON;
    } else {
      for (const entry of absentActive) {
        const index = fileStates.findIndex((state) => state.path === entry.path);
        const absentSweeps = (entry.absentSweeps ?? 0) + 1;
        if (absentSweeps >= ABSENT_SWEEPS_BEFORE_WITHDRAWAL) {
          fileStates[index] = this.cloneFileState(entry, { absentSweeps, withdrawnAt: new Date() });
          // A placeholder entry (no `documentId`) was never ingested, so there is no document
          // version to withdraw — only stop tracking it as active, above.
          if (entry.documentId !== undefined) {
            documentIdsToWithdraw.push(entry.documentId);
          }
        } else {
          fileStates[index] = this.cloneFileState(entry, { absentSweeps });
        }
      }
    }

    const finalized = await this.finalizeSync(
      source._id,
      leaseToken,
      fileStates,
      'ok',
      undefined,
      withdrawalSuppressedReason,
    );
    if (!finalized) {
      this.logger.debug(
        `Source '${sourceId}' sync superseded by a newer attempt; discarding results`,
      );
      return { disabled: false, intervalMs: null };
    }

    if (documentIdsToWithdraw.length > 0) {
      await this.documentsService.withdrawVersions(
        documentIdsToWithdraw,
        'source-file-absent',
        source.tenantId,
      );
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
   * A brand-new file that fails gets a placeholder entry pushed onto `fileStates` —
   * `{path, sizeBytes, mtimeMs, lastError}`, with no `documentId` and no `sha256`, since nothing
   * was ever ingested and an unresolvable-kind or oversized rejection never reads bytes to hash —
   * so the file is listed against its source instead of only logged. `documentId` presence is what
   * distinguishes a placeholder from a synced entry everywhere below: the watermark early-return,
   * the dedupe branch, and the create-vs-add-version choice all require it, so a placeholder is
   * never mistaken for a synced file and is retried on every sweep until it succeeds or the
   * underlying file is fixed. An existing (non-placeholder) entry that fails keeps its previous
   * watermark (`sizeBytes`/`mtimeMs`/`sha256`/`documentId`) unchanged alongside the new
   * `lastError` — advancing the watermark on a failed attempt would make the cheap watermark check
   * above skip the file forever without it ever having synced.
   *
   * The cheap watermark early-return REQUIRES `!existing.withdrawnAt` — a withdrawn path that
   * reappears with byte-identical `sizeBytes`/`mtimeMs` (`cp -p`, `rsync -a`, and `git checkout`
   * all preserve both by default) would otherwise never re-enter this method, leaving the document
   * withdrawn forever while the source's own file state shows nothing wrong. Falling through to the
   * hash check below is what lets the dedupe branch reinstate it. An absent-but-not-yet-withdrawn
   * path that simply reappears also clears `absentSweeps` here — a stale count left over from one
   * absent sweep must not survive into a later, unrelated absence and withdraw on its first strike.
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

    if (
      existing &&
      existing.documentId !== undefined &&
      existing.sizeBytes === file.sizeBytes &&
      existing.mtimeMs === file.mtimeMs &&
      !existing.withdrawnAt
    ) {
      if (existing.absentSweeps !== undefined) {
        fileStates[index] = this.cloneFileState(existing, { absentSweeps: undefined });
      }
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

      if (existing && existing.documentId !== undefined && existing.sha256 === sha256) {
        fileStates[index] = this.cloneFileState(existing, {
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
          lastError: undefined,
          absentSweeps: undefined,
          withdrawnAt: undefined,
        });
        if (existing.withdrawnAt !== undefined) {
          await this.documentsService.reinstateVersions([existing.documentId], tenantId);
        }
        return;
      }

      const uploadedFile: UploadedFileLike = {
        originalname: filename,
        mimetype: '',
        size: content.length,
        buffer: content,
      };

      // `sourceClass`/`sourceId` only matter on the document-creation branch below — `addVersion`
      // (existing-document branch) writes bytes onto a document that already has both, unrelated
      // to this sync attempt's source. A placeholder entry (no `documentId`) has no document to add
      // a version to, so it takes the creation branch exactly like a brand-new path would.
      const response =
        existing && existing.documentId !== undefined
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
      // The genuinely-changed-bytes path above created a fresh version that is never itself
      // withdrawn, but an EARLIER version of the same document can still carry `withdrawnAt` from a
      // prior sweep; this reconciles the whole document, not just this new version. A placeholder
      // never carries `withdrawnAt` (only a `documentId`-bearing entry is ever withdrawn — see
      // `runSync`), so this is unreachable for one, but the guard is explicit rather than assumed.
      if (existing && existing.documentId !== undefined && existing.withdrawnAt !== undefined) {
        await this.documentsService.reinstateVersions([existing.documentId], tenantId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (existing) {
        fileStates[index] = this.cloneFileState(existing, { lastError: message });
      } else {
        fileStates.push({
          path: file.relativePath,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
          lastError: message,
        });
      }
    }
  }

  /**
   * Builds a plain-object replacement for one `fileStates` entry. `state` is a live Mongoose
   * subdocument at runtime (the array element comes straight from `source.fileStates`, only typed
   * as the plain `SourceFileState` interface) — its schema-defined fields are getters on the
   * subdocument's prototype, not the instance's own enumerable properties, so `{ ...state, ... }`
   * silently drops every field it does not explicitly override (`path`, `sha256`, `documentId`,
   * everything) and keeps only Mongoose's internal bookkeeping properties instead. Reading each
   * field through its getter here, rather than spreading, works identically whether `state` is a
   * real subdocument or the plain object a unit test's mocked model hands back.
   */
  private cloneFileState(
    state: SourceFileState,
    overrides: Partial<SourceFileState>,
  ): SourceFileState {
    return {
      path: state.path,
      sha256: state.sha256,
      sizeBytes: state.sizeBytes,
      mtimeMs: state.mtimeMs,
      documentId: state.documentId,
      lastError: state.lastError,
      absentSweeps: state.absentSweeps,
      withdrawnAt: state.withdrawnAt,
      ...overrides,
    };
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
   *  comment for why the loss check lives here rather than at `claimAttempt`.
   *
   *  `withdrawalSuppressedReason`, populated only on the `'ok'` branch, is what makes a G1/G2 guard
   *  firing visible (`runSync`'s own doc comment) — the same write that persists `fileStates`
   *  stamps `lastWithdrawalSuppressedAt`/`Reason` rather than a separate call, so there is no window
   *  in which one succeeds and the other is lost to a lease race. */
  private async finalizeSync(
    sourceId: Types.ObjectId,
    leaseToken: Types.ObjectId,
    fileStates: SourceFileState[],
    status: 'ok' | 'failed',
    errorMessage?: string,
    withdrawalSuppressedReason?: string,
  ): Promise<boolean> {
    const finalized = await this.sourceModel.findOneAndUpdate(
      { _id: sourceId, syncLeaseToken: leaseToken },
      status === 'ok'
        ? {
            $set: {
              fileStates,
              lastSyncAt: new Date(),
              lastSyncStatus: status,
              ...(withdrawalSuppressedReason
                ? {
                    lastWithdrawalSuppressedAt: new Date(),
                    lastWithdrawalSuppressedReason: withdrawalSuppressedReason,
                  }
                : {}),
            },
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
