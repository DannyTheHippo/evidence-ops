import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import type { Observable } from 'rxjs';
import {
  catchError,
  concatMap,
  distinctUntilChanged,
  map,
  merge,
  of,
  takeUntil,
  timer,
} from 'rxjs';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import {
  Conflict,
  ConflictDocument,
  MIN_CONFLICTING_FACTS,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import type {
  DocumentEmailOrigin,
  DocumentLocation,
  DocumentSourceClass,
  DocumentSourceKind,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  Document,
  DocumentDocument,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
  type DocumentVersionWithdrawnReason,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  ExtractedFact,
  ExtractedFactDocument,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  DOCUMENT_STORE,
  type DocumentStore,
} from '../../../providers/storage/document-store.interface';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../providers/workflow-engine/workflow-engine.interface';
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_REAUTH_INTERVAL_MS,
  SSE_STREAM_ERROR_MESSAGE,
} from '../../../shared/constants/sse.constant';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import { reauthTicks$ } from '../../../shared/utils/stream-session.util';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import type { IngestDocumentVersionInput } from '../../../workflows/types';
import { WorkflowRunsService } from '../workflow-runs/workflow-runs.service';
import {
  AMBIGUOUS_UPLOAD_MIME_TYPES,
  contentMatchesDeclaredKind,
  DOCUMENTS_STREAM_INTERVAL_MS,
  MIME_TYPE_TO_SOURCE_KIND,
  resolveUploadKind,
  SOURCE_KIND_TO_MIME_TYPE,
} from './documents.constant';
import type { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import {
  DEFAULT_DOCUMENT_SORT_FIELD,
  DEFAULT_DOCUMENT_SORT_DIRECTION,
  type ListDocumentsRequestDto,
} from './dtos/request/list-documents.request.dto';
import { UploadDocumentRequestDto } from './dtos/request/upload-document.request.dto';
import { DocumentLocationResponseDto } from './dtos/response/document-location.response.dto';
import { DocumentResponseDto } from './dtos/response/document.response.dto';
import { DocumentVersionLookupResponseDto } from './dtos/response/document-version-lookup.response.dto';
import { DocumentVersionResponseDto } from './dtos/response/document-version.response.dto';
import { DocumentWithVersionsResponseDto } from './dtos/response/document-with-versions.response.dto';
import { EvidenceChunkResponseDto } from './dtos/response/evidence-chunk.response.dto';
import {
  ContentTypeMismatchException,
  DocumentNotFoundException,
  DocumentVersionNotFoundException,
  MissingFileException,
  UnresolvableContentTypeException,
  UnsupportedContentTypeException,
} from './exceptions/documents.exception';
import { neutralizeForDisplay } from '../ingestion/sanitize-evidence-text';
import { sanitizeDownloadFilename } from './sanitize-download-filename.util';
import type { UploadedFileLike } from './types/uploaded-file.type';

/** Return shape of `getVersionContent` — the bytes plus everything the controller needs to build
 * the download response, so the controller never has to re-derive a `Content-Type` or filename. */
export interface DocumentVersionContent {
  content: Buffer;
  contentType: string;
  filename: string;
}

/** Raw documents, not DTOs — `upload()` maps this through `toDocumentDto`, and Phase 3B's
 * `submit_evidence` reads `currentVersion._id` and `isNewVersion` directly off it. */
export interface UploadOutcome {
  document: DocumentDocument;
  currentVersion: DocumentVersionDocument;
  /** False on the content-addressed dedupe path (`uploadVersion` reusing an existing sha256,
   * tenant-wide) — distinguishes "no new bytes were stored" from every path that actually created
   * a version, so `upload()` only ever starts ingestion for a version that needs it. */
  isNewVersion: boolean;
}

/** `sourceClass` arrives two ways: a browser upload's own `UploadDocumentRequestDto.sourceClass`
 * (the uploader declaring what the file is), or a connector sync (`SourcesService.syncOneFile`)
 * inheriting it from the originating `Source.sourceClass`. `sourceId` only ever comes from the
 * sync path — a browser upload has no source to attribute. */
interface UploadSourceOptions {
  sourceClass?: DocumentSourceClass;
  sourceId?: Types.ObjectId;
  /** Set only by `EmailAttachmentService`, which creates a document out of a part it unwrapped from
   * an `.eml`. Recorded on the document as provenance — see `DocumentEmailOrigin`. */
  emailOrigin?: DocumentEmailOrigin;
  /** Where these bytes were seen: a connector's relative path (`SourcesService.syncOneFile`) or an
   * attachment's filename (`EmailAttachmentService`). Falls back to `file.originalname` when
   * absent — a browser upload's own filename is its location. */
  path?: string;
}

/** The fields that identify one `DocumentLocation` — everything but when it was first seen. */
type DocumentLocationKey = Omit<DocumentLocation, 'firstSeenAt'>;

/** A concurrent writer won the tenant-wide `document_versions_tenantId_sha256_unique` index
 * between `uploadVersion`'s dedupe check and this write — the driver's own duplicate-key code,
 * not a Mongoose validation error. */
function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

/**
 * `ingestDocumentVersion` — the Temporal workflow type name in
 * `src/workflows/ingest-document-version.workflow.ts` — is not exported as a constant anywhere in
 * `src/workflows/**` (that directory only exports argument/return types; see its determinism-fence
 * rationale, also called out in `qa.service.ts`'s identical `ANSWER_QUESTION_WORKFLOW_TYPE`
 * comment). Duplicated here rather than imported, for the same reason: this module reaches into
 * `src/workflows/**` for types only, never runtime exports.
 */
const INGEST_DOCUMENT_VERSION_WORKFLOW_TYPE = 'ingestDocumentVersion';

// Internal to `streamList` only.
type DocumentsStreamEvent =
  | { type: 'documents'; data: { docs: DocumentResponseDto[]; count: number } }
  | { type: 'heartbeat'; data: Record<string, never> };

@Injectable()
export class DocumentsService {
  constructor(
    @InjectModel(Document.name)
    private readonly documentModel: Model<DocumentDocument>,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @InjectModel(EvidenceChunk.name)
    private readonly evidenceChunkModel: Model<EvidenceChunkDocument>,

    @InjectModel(ExtractedFact.name)
    private readonly extractedFactModel: Model<ExtractedFactDocument>,

    @InjectModel(Conflict.name)
    private readonly conflictModel: Model<ConflictDocument>,

    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,

    @Inject(DOCUMENT_STORE)
    private readonly documentStore: DocumentStore,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly workflowRunsService: WorkflowRunsService,

    private readonly auditService: AuditService,

    private readonly logger: AppLogger,

    private readonly config: TypedConfigService,
  ) {
    this.logger.init(DocumentsService.name);
  }

  async upload(
    file: UploadedFileLike | undefined,
    dto: UploadDocumentRequestDto,
    tenantId: string,
    source?: UploadSourceOptions,
  ): Promise<DocumentResponseDto> {
    const outcome = await this.uploadVersion(file, dto, tenantId, source);
    return this.toDocumentDto(outcome.document, outcome.currentVersion);
  }

  /**
   * Everything `upload()` does, minus the response mapping — Phase 3B's `submit_evidence` calls
   * this directly for the version id and `isNewVersion`, neither of which survives `toDocumentDto`.
   */
  async uploadVersion(
    file: UploadedFileLike | undefined,
    dto: UploadDocumentRequestDto,
    tenantId: string,
    source?: UploadSourceOptions,
  ): Promise<UploadOutcome> {
    if (!file) {
      throw new MissingFileException('A file is required');
    }

    // Input gate, fails CLOSED before any I/O (hashing, storage write), regardless of
    // new-document vs new-version. Two distinct rejections, both `resolveUploadKind` returning
    // `undefined`, get two distinct statuses: a MIME `resolveUploadKind` doesn't recognize at all
    // is a 415 (the media type itself is the problem); a MIME it recognizes as ambiguous
    // (`AMBIGUOUS_UPLOAD_MIME_TYPES`) but couldn't resolve via the extension allowlist — e.g.
    // `application/vnd.ms-excel` + `.xls`, the Windows-.csv-lookalike case — is a 400 (the
    // filename/content-type combination itself is malformed, not merely unsupported).
    const sourceKind = resolveUploadKind(file.mimetype, file.originalname);
    if (!sourceKind) {
      if (AMBIGUOUS_UPLOAD_MIME_TYPES.has(file.mimetype.toLowerCase())) {
        throw new UnresolvableContentTypeException(
          `Could not resolve a document type for '${file.originalname}' with ambiguous content type '${file.mimetype}'`,
        );
      }
      throw new UnsupportedContentTypeException(
        `Unsupported content type '${file.mimetype}' for file '${file.originalname}'`,
      );
    }

    // Second half of the same input gate, still before any I/O: `resolveUploadKind` only ever
    // looked at the declared MIME and filename, both of which the client controls. A magic-byte
    // sniff of the actual bytes closes the gap it can't — a PDF named 'report.txt' and sent as
    // 'text/plain' resolves to `txt` above and would otherwise be stored under a canonical
    // 'text/plain' MIME that launders the lie for every downstream consumer.
    if (!contentMatchesDeclaredKind(file.buffer, sourceKind)) {
      throw new ContentTypeMismatchException(
        `File '${file.originalname}' was declared as content type '${file.mimetype}' (resolved to '${sourceKind}'), but its bytes do not match that format`,
      );
    }

    // The canonical MIME for the resolved kind, not the browser's raw `file.mimetype` — this is
    // what gets persisted and stored, so the parser registry's exact-match lookup
    // (`ParserRegistry.resolve`) never has to learn about a browser's lie either.
    const canonicalMimeType = SOURCE_KIND_TO_MIME_TYPE[sourceKind];

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const callerLocation: DocumentLocationKey = {
      path: source?.path ?? file.originalname,
      sourceId: source?.sourceId,
      emailOrigin: source?.emailOrigin,
    };

    // Resolved once, up front, whenever the caller names a target — both the dedupe check below
    // and `addVersion` need it, and a cross-tenant/unknown id must 404 before any write regardless
    // of whether the uploaded bytes turn out to be a tenant-wide duplicate.
    const callerDocument = dto.documentId
      ? await this.requireDocument(dto.documentId, tenantId)
      : undefined;

    // Content-addressed within the tenant, not just the target document: bytes already carried by
    // any document of this tenant resolve to that document rather than minting a new version
    // anywhere. Checked before either write path below, since a hit takes neither.
    const dedupe = await this.resolveTenantWideDuplicate(
      sha256,
      callerLocation,
      callerDocument,
      tenantId,
    );

    const { document, currentVersion, isNewVersion } =
      dedupe ??
      (callerDocument
        ? await this.addVersion(
            callerDocument,
            dto,
            sourceKind,
            sha256,
            file,
            canonicalMimeType,
            tenantId,
            source,
            callerLocation,
          )
        : await this.createDocument(
            dto,
            sourceKind,
            sha256,
            file,
            canonicalMimeType,
            tenantId,
            source,
            callerLocation,
          ));

    // Fire-and-forget, mirroring `QaService.startQuestion`: a slow parse/embed must never block
    // the upload response, which is the entire point of running ingestion as a durable workflow
    // rather than an inline call into `IngestionService`. Never starts for the dedupe path — no
    // new bytes were stored, so there is nothing new to ingest.
    if (isNewVersion) {
      const handle = await this.workflowEngine.start(INGEST_DOCUMENT_VERSION_WORKFLOW_TYPE, {
        documentVersionId: currentVersion._id.toString(),
        // Per-upload opt-in (D5 of the approvals milestone) — see `IngestDocumentVersionInput`'s
        // own doc comment (`src/workflows/types.ts`) for why this travels on the workflow input
        // rather than a persisted per-document setting, and why the default must stay "do not
        // gate": `dto.requireApproval` undefined/false here means this key doesn't change the
        // ungated path at all.
        requireApproval: dto.requireApproval,
        documentTitle: document.title,
        // The uploader's tenant, not the default: the workflow's approval gate reads the durable
        // `Approval` row through `MongoApprovalChannel.getDecision`, which is now tenant-scoped and
        // fails closed to `rejected` on a mismatch. Leaving this unset would have left every gated
        // ingest looking up its own approval in the default tenant while the row was written in the
        // uploader's — a gate that denies correctly for the wrong reason.
        tenantId,
      } satisfies IngestDocumentVersionInput);

      // Fails OPEN: the workflow has already started and will ingest the version regardless of
      // this projection row, so a write failure here is logged and swallowed rather than turning
      // an otherwise-successful upload into an error the caller has to retry.
      try {
        await this.workflowRunsService.create({
          workflowId: handle.id,
          workflowType: 'ingest-document-version',
          status: handle.status,
          tenantId,
          subjectId: currentVersion._id.toString(),
          subjectType: 'DocumentVersion',
        });
      } catch (error) {
        this.logger.warn(
          `Failed to record workflow run '${handle.id}' for document version '${currentVersion._id.toString()}': ${String(error)}`,
        );
      }
    }

    this.logger.debug(
      `Document '${document._id.toString()}' upload resolved to version '${currentVersion._id.toString()}'`,
    );

    return { document, currentVersion, isNewVersion };
  }

  async list(
    pagination: ListDocumentsRequestDto,
    tenantId: string,
  ): Promise<DocumentResultWithCount<DocumentResponseDto>> {
    // `ingestionStatus` lives on `DocumentVersion`, not `Document` — a filter key on the
    // `documentModel` query below cannot see it. Two-step: resolve which versions currently carry
    // the requested status, then filter documents to those whose CURRENT version is one of them.
    // A document whose failed version was superseded by a completed one is deliberately excluded —
    // that is not a live failure, matching `HomePage.tsx`'s client-side filter. Never denormalize
    // this onto `Document` (a second source of truth for a value the version already owns) and
    // never reach for `$lookup` (replaces a tested `find` path with an aggregation for one filter).
    let currentVersionFilter: { $in: Types.ObjectId[] } | undefined;
    if (pagination.ingestionStatus) {
      const matchingVersions = await this.documentVersionModel.find(
        { tenantId, ingestionStatus: pagination.ingestionStatus },
        { _id: 1 },
      );
      currentVersionFilter = { $in: matchingVersions.map((version) => version._id) };
    }

    const filter = {
      tenantId,
      ...(currentVersionFilter ? { currentVersionId: currentVersionFilter } : {}),
    };

    const [documents, count] = await Promise.all([
      this.documentModel.find(filter, null, {
        sort: resolveSort(
          pagination.sort,
          pagination.sortDir,
          DEFAULT_DOCUMENT_SORT_FIELD,
          DEFAULT_DOCUMENT_SORT_DIRECTION,
        ),
        skip: pagination.skip,
        limit: pagination.limit,
      }),
      this.documentModel.countDocuments(filter),
    ]);

    const versionIds = documents
      .map((document) => document.currentVersionId)
      .filter((id): id is Types.ObjectId => id !== undefined);
    const versions = await this.documentVersionModel.find({
      _id: { $in: versionIds },
      tenantId,
    });
    const versionById = new Map(versions.map((version) => [version._id.toString(), version]));

    const docs = documents.map((document) => {
      const currentVersion = document.currentVersionId
        ? versionById.get(document.currentVersionId.toString())
        : undefined;
      return this.toDocumentDto(document, this.assertCurrentVersion(document, currentVersion));
    });

    return { docs, count };
  }

  /**
   * How many documents ingested from `sourceId` still carry `previousClass` rather than the
   * source's current `sourceClass` — the drift `SourcesService.getClassDriftReport` surfaces and
   * `applySourceClassToDrifted` remedies. Scoped by exact equality on `previousClass`, never `$ne
   * sourceClass`: a document already carrying some third class was never touched by the change
   * that produced this drift and must not be counted as drifted by it.
   */
  async countBySourceAndClass(
    sourceId: Types.ObjectId,
    sourceClass: DocumentSourceClass,
    tenantId: string,
  ): Promise<number> {
    return this.documentModel.countDocuments({ tenantId, sourceId, sourceClass });
  }

  /**
   * Rewrites `sourceClass` to `toClass` on every document ingested from `sourceId` that still
   * carries `fromClass` — recomputed fresh at call time rather than against an id list captured
   * earlier, so a sync landing between a drift report and this call is reconciled too, and a
   * caller must read the returned count rather than assume it matches whatever it reported
   * earlier. Scoped by exact equality on `fromClass`, the same reasoning as
   * `countBySourceAndClass`.
   */
  async applySourceClassToDrifted(
    sourceId: Types.ObjectId,
    fromClass: DocumentSourceClass,
    toClass: DocumentSourceClass,
    tenantId: string,
  ): Promise<number> {
    const result = await this.documentModel.updateMany(
      { tenantId, sourceId, sourceClass: fromClass },
      { $set: { sourceClass: toClass } },
    );
    return result.modifiedCount;
  }

  /**
   * Soft-withdraws every not-yet-withdrawn version of each document in `documentIds` —
   * `SourcesService.runSync`'s two-strike absence guard, called only after `finalizeSync` confirms
   * the sync attempt still owns its lease (see that method's own doc comment for why). Chunks and
   * facts are untouched: this is retrieval-exclusion metadata, not `remove`'s hard delete. Plain
   * `$set`, not an aggregation pipeline — `updatePipeline: true` (`.claude/rules/mongoose.md`) does
   * not apply. Idempotent via `withdrawnAt: { $exists: false }`, so a version already withdrawn by
   * an earlier call keeps its original `withdrawnAt` rather than being restamped to a later time.
   */
  async withdrawVersions(
    documentIds: Types.ObjectId[],
    reason: DocumentVersionWithdrawnReason,
    tenantId: string,
  ): Promise<number> {
    const result = await this.documentVersionModel.updateMany(
      { documentId: { $in: documentIds }, tenantId, withdrawnAt: { $exists: false } },
      { $set: { withdrawnAt: new Date(), withdrawnReason: reason } },
    );
    return result.modifiedCount;
  }

  /**
   * Reverses `withdrawVersions` for each document in `documentIds` — `SourcesService.syncOneFile`
   * calls this when a previously-absent path resolves again, never as a side effect of `upload`: a
   * restored file with unchanged bytes hits the content-addressed dedupe branch there, which
   * returns the existing version untouched and reaches no write path of its own. Idempotent the
   * same way as `withdrawVersions`, scoped by `withdrawnAt: { $exists: true }`.
   */
  async reinstateVersions(documentIds: Types.ObjectId[], tenantId: string): Promise<number> {
    const result = await this.documentVersionModel.updateMany(
      { documentId: { $in: documentIds }, tenantId, withdrawnAt: { $exists: true } },
      { $unset: { withdrawnAt: '', withdrawnReason: '' } },
    );
    return result.modifiedCount;
  }

  /**
   * Polling-on-the-server, deliberately not a MongoDB change stream — see
   * `QaService.streamAnswer`'s identical rejected-alternative note.
   *
   * `pagination` is the caller's current `skip`/`limit`, threaded straight through to `list` —
   * this stream mirrors a list the caller is paging through, so stream and poll must agree on
   * every page, not only the newest one. A hardcoded newest-page window here is what used to
   * force the SPA to disable the stream past page 1 (`DocumentList.tsx`'s former workaround);
   * with the caller's own page threaded through instead, that stopgap is no longer needed.
   *
   * `pagination` is typed `PaginationRequestDto`, not `ListDocumentsRequestDto` — this route does
   * not accept `sort`/`sortDir`, so `list` always resolves its default sort here regardless of
   * what sort a concurrent `GET /documents` request used. Agreement holds for `skip`/`limit`
   * only; a caller polling a non-default sort through the plain GET route sees a stream that
   * agrees on the page window but not on ordering within it.
   *
   * No `peekList`/`list` split, unlike `qa`/`workflow-runs`/`approvals`: `list` above never
   * records an audit row to begin with (unlike `getAnswerById`/`findById`/`listPending`), so there
   * is nothing this tick could over-record and nothing to gate an opening audit write on either —
   * this is the one stream of the three with no audit story at all.
   *
   * No terminal `takeWhile`: unlike the answer/run streams, a document list has no terminal state
   * of its own to close the connection on. Two other ends instead: `reauthTicks$` closes it if the
   * connecting session is gone or moved tenants (re-checked every `SSE_REAUTH_INTERVAL_MS`, same as
   * the other two streams — see `QaService.streamAnswer`'s identical `takeUntil`), and a bare
   * `timer(config.sse.maxStreamLifetimeMs)` bounds how long any single connection may stay open
   * regardless — this is the one stream of the three with no other terminal condition at all, so
   * without it a client that never disconnects holds the slot forever. Short of either, the
   * connection still stays open until the client disconnects, same as before.
   */
  streamList(
    tenantId: string,
    userId: string,
    pagination: PaginationRequestDto,
  ): Observable<MessageEvent> {
    const documents$: Observable<DocumentsStreamEvent> = timer(
      0,
      DOCUMENTS_STREAM_INTERVAL_MS,
    ).pipe(
      concatMap(() => this.list(pagination, tenantId)),
      map(({ docs, count }) => ({
        docs: docs.map((doc) => toResponseDto(DocumentResponseDto, doc)),
        count,
      })),
      // Fresh mapped array every tick, so comparing serialized JSON (not object identity) is what
      // actually suppresses a re-emit when nothing changed between polls.
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      map((data): DocumentsStreamEvent => ({ type: 'documents', data })),
    );

    const heartbeat$: Observable<DocumentsStreamEvent> = timer(
      SSE_HEARTBEAT_INTERVAL_MS,
      SSE_HEARTBEAT_INTERVAL_MS,
    ).pipe(map((): DocumentsStreamEvent => ({ type: 'heartbeat', data: {} })));

    return merge(documents$, heartbeat$).pipe(
      takeUntil(
        reauthTicks$(
          { userId, tenantId },
          (id) =>
            this.userModel.findById(id).then((user) => (user ? { tenantId: user.tenantId } : null)),
          SSE_REAUTH_INTERVAL_MS,
        ),
      ),
      takeUntil(timer(this.config.sse.maxStreamLifetimeMs)),
      map((event): MessageEvent => event),
      // FAIL OPEN TO POLLING — see `QaService.streamAnswer`'s identical reasoning: the SPA's
      // retained `listDocuments()` polling is the fallback. The event carries a fixed client-facing
      // message, not `(error as Error).message` — see `SSE_STREAM_ERROR_MESSAGE`'s doc comment; the
      // real error is logged here instead.
      catchError((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`streamList failed for tenant '${tenantId}': ${message}`);
        return of<MessageEvent>({ type: 'error', data: { message: SSE_STREAM_ERROR_MESSAGE } });
      }),
    );
  }

  async getById(id: string, tenantId: string): Promise<DocumentWithVersionsResponseDto> {
    if (!Types.ObjectId.isValid(id)) {
      throw new DocumentNotFoundException(`Document '${id}' not found`);
    }

    // Cross-tenant id must be indistinguishable from a missing one — `findOne` with the tenant
    // predicate rather than `findById` plus a separate ownership check.
    const document = await this.documentModel.findOne({ _id: id, tenantId });
    if (!document) {
      throw new DocumentNotFoundException(`Document '${id}' not found`);
    }

    const versions = await this.documentVersionModel
      .find({ documentId: document._id, tenantId })
      .sort({ versionNumber: 1 });

    const currentVersion = versions.find(
      (version) => document.currentVersionId && version._id.equals(document.currentVersionId),
    );

    return {
      ...this.toDocumentDto(document, this.assertCurrentVersion(document, currentVersion)),
      versions: versions.map((version) => this.toVersionDto(version)),
    };
  }

  /**
   * Resolves each requested version id to the document it belongs to — the join a `Citation`
   * needs to become a link, since it carries `docVersionId` but no `documentId`. An id that does
   * not resolve (unknown, cross-tenant, or malformed past `@IsMongoId`) is silently absent from
   * `docs` rather than a 404: one stale id must not fail a whole page of citations, and a
   * cross-tenant id must stay indistinguishable from a nonexistent one, so this endpoint cannot
   * be used as an existence oracle. A soft-withdrawn version still resolves, with `withdrawn: true`.
   */
  async lookupVersions(
    versionIds: string[],
    tenantId: string,
  ): Promise<DocumentResultWithCount<DocumentVersionLookupResponseDto>> {
    const versions = await this.documentVersionModel.find({
      _id: { $in: versionIds.map((id) => new Types.ObjectId(id)) },
      tenantId,
    });

    const documentIds = [...new Set(versions.map((version) => version.documentId.toString()))];
    const documents = await this.documentModel.find({
      _id: { $in: documentIds.map((id) => new Types.ObjectId(id)) },
      tenantId,
    });
    const documentById = new Map(documents.map((document) => [document._id.toString(), document]));

    const docs = versions.map((version) => {
      const documentId = version.documentId.toString();
      const document = documentById.get(documentId);
      if (!document) {
        // A version whose owning document does not resolve is corruption, not a normal miss —
        // the same data-integrity fault `EvidenceRetrievalService.retrieve`'s identical join
        // throws on, and distinct from a requested id that never resolved to a version at all
        // (silently dropped above, never here).
        throw new InternalServerErrorException(
          `Document version '${version._id.toString()}' references document '${documentId}', which no longer exists`,
        );
      }

      return {
        versionId: version._id.toString(),
        documentId,
        documentTitle: document.title,
        versionNumber: version.versionNumber,
        sourceKind: document.sourceKind,
        withdrawn: version.withdrawnAt !== undefined,
      };
    });

    return { docs, count: docs.length };
  }

  /**
   * This route is what actually closes the GridFS tenant bypass (`document-store.interface.ts`'s
   * `metadata` comment): `tenantScopePlugin` cannot reach GridFS, so a version row that resolves
   * correctly through the tenant-scoped `document_versions` lookup below still has to have its
   * stored bytes' `metadata.tenantId` checked separately at read time. Two failure directions,
   * both deliberate:
   * - Present and mismatched: FAIL CLOSED, a 404 indistinguishable from "not found" — the route
   *   must not let a caller learn a wrong-tenant version id exists by getting a different error.
   * - Absent (a stored object from before this stamp existed): FAIL OPEN and serve, with a warning
   *   — refusing would break every document uploaded before the stamp was introduced.
   */
  async getVersionContent(
    versionId: string,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentVersionContent> {
    if (!Types.ObjectId.isValid(versionId)) {
      throw new DocumentVersionNotFoundException(`Document version '${versionId}' not found`);
    }

    // Cross-tenant id must be indistinguishable from a missing one — same `findOne` + tenant
    // predicate pattern as `getById`/`addVersion` above.
    const version = await this.documentVersionModel.findOne({ _id: versionId, tenantId });
    if (!version) {
      throw new DocumentVersionNotFoundException(`Document version '${versionId}' not found`);
    }

    const document = await this.documentModel.findOne({ _id: version.documentId, tenantId });
    if (!document) {
      throw new DocumentVersionNotFoundException(`Document version '${versionId}' not found`);
    }

    const stored = await this.documentStore.get(version.storageKey);
    if (!stored) {
      // A version row created by `addVersion`/`createDocument` always stores its bytes in the
      // same call that creates the row — a version with no resolvable stored object is corruption,
      // not a client error, mirroring `IngestionService`'s identical reasoning for a missing
      // stored object on the ingest path.
      throw new InternalServerErrorException(
        `Document version '${versionId}' has no stored content for key '${version.storageKey}'`,
      );
    }

    const storedTenantId = stored.metadata.tenantId;
    if (storedTenantId !== undefined && storedTenantId !== tenantId) {
      throw new DocumentVersionNotFoundException(`Document version '${versionId}' not found`);
    }
    if (storedTenantId === undefined) {
      this.logger.warn(
        `Document version '${versionId}' storage object '${version.storageKey}' has no tenantId stamp; serving without one`,
      );
    }

    const extension = MIME_TYPE_TO_SOURCE_KIND[stored.contentType] ?? 'bin';
    const filename = sanitizeDownloadFilename(document.title, version.versionNumber, extension);

    await this.auditService.record({
      action: 'documents.version.downloaded',
      actorId,
      subject: { entityType: 'DocumentVersion', entityId: version._id.toString() },
      tenantId,
    });

    return { content: stored.content, contentType: stored.contentType, filename };
  }

  /**
   * Serves the viewer's evidence view of a version — the persisted `evidence_chunks`, not a
   * re-parse of the source document. Per-element parser output is never persisted, re-parsing on
   * demand would re-open injection screening inside the request path, and persisting elements
   * would need its own migration, a backfill, and 2x text storage. Chunks are already
   * tenant-scoped, already sanitized, and are exactly what a citation's `chunkId` points at.
   *
   * No pagination: chunks run ~700 tokens each under the 50MB upload cap
   * (`MAX_FILE_SIZE_BYTES`), so a whole version is a bounded response.
   */
  async listVersionChunks(
    versionId: string,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<EvidenceChunkResponseDto>> {
    if (!Types.ObjectId.isValid(versionId)) {
      throw new DocumentVersionNotFoundException(`Document version '${versionId}' not found`);
    }

    // Cross-tenant id must be indistinguishable from a missing one — same `findOne` + tenant
    // predicate pattern as `getVersionContent` above.
    const version = await this.documentVersionModel.findOne({ _id: versionId, tenantId });
    if (!version) {
      throw new DocumentVersionNotFoundException(`Document version '${versionId}' not found`);
    }

    // `embedding` is large and the viewer never needs it — excluded at the query projection so it
    // never leaves Mongo, rather than fetched and then dropped by the response DTO.
    const chunks = await this.evidenceChunkModel.find(
      { documentVersionId: version._id, tenantId },
      { embedding: 0 },
    );

    // Application-side, not a Mongo $sort: a single `documentVersionId` is parser-homogeneous —
    // one parser produced every chunk in it (`IngestionService.ingestVersion`) — so every chunk's
    // locator here is the same union member and mutually comparable.
    const sorted = [...chunks].sort((a, b) =>
      this.locatorSortKey(a.locator).localeCompare(this.locatorSortKey(b.locator)),
    );

    await this.auditService.record({
      action: 'documents.version.chunks.listed',
      actorId,
      subject: { entityType: 'DocumentVersion', entityId: version._id.toString() },
      tenantId,
    });

    return { docs: sorted.map((chunk) => this.toChunkDto(chunk)), count: sorted.length };
  }

  /**
   * Hard delete with cascade — the first destructive route in the API, and admin-gated at the
   * controller for that reason. Order is chosen for retry safety, not for referential neatness:
   * the document row is deleted LAST, so a process that dies mid-cascade leaves the document (and
   * whatever children survived) still discoverable and re-deletable, rather than orphaning rows
   * behind a parent that no longer resolves. Reversing the order — document first — would strand
   * every child the crash left behind, invisible to any tenant-scoped lookup that starts from the
   * document.
   *
   * Every query below is explicitly tenant-scoped, even where `tenantScopePlugin` would already
   * backstop it — this is the one path in the codebase where a missed predicate deletes another
   * tenant's evidence, not just leaks it.
   */
  async remove(id: string, actorId: string, tenantId: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      throw new DocumentNotFoundException(`Document '${id}' not found`);
    }

    // Cross-tenant id must be indistinguishable from a missing one — same `findOne` + tenant
    // predicate pattern as every other lookup in this service.
    const document = await this.documentModel.findOne({ _id: id, tenantId });
    if (!document) {
      throw new DocumentNotFoundException(`Document '${id}' not found`);
    }

    const versions = await this.documentVersionModel.find({ documentId: document._id, tenantId });
    const versionIds = versions.map((version) => version._id);

    const facts = await this.extractedFactModel.find(
      { documentVersionId: { $in: versionIds }, tenantId },
      { _id: 1 },
    );
    const factIds = facts.map((fact) => fact._id);

    // A conflict's `factIds` is unbounded and grouping is by `(entity, metric, period)`, so three
    // documents disagreeing about one cap rate produce ONE conflict with three facts — resolving
    // the whole conflict just because one of its facts got deleted would silently drop a
    // disagreement that is still live between the surviving facts. Instead: pull this document's
    // fact ids out of `factIds` first, then only resolve a conflict the pull left with fewer than
    // `MIN_CONFLICTING_FACTS` remaining references. Aggregation-pipeline update (`$setDifference`)
    // because a plain `$pull` cannot subtract a fixed array from `factIds` in one query the way
    // `$setDifference` can.
    if (factIds.length > 0) {
      // Every conflict referencing one of this document's facts gets its `factIds` pruned here,
      // regardless of status: a `resolved`/`dismissed` conflict's `factIds` must keep resolving to
      // live `ExtractedFact`s exactly as much as an `open` one's, since both are read by
      // `ConflictsService.list`. Not scoped to `status: 'open'` — the query can no longer take the
      // `status` segment of the `conflicts_tenantId_status_factIds` compound index (migration
      // 0006), but this is the rare document-delete path, not a per-request hot path.
      // `updatePipeline: true` is REQUIRED, not decorative: Mongoose 9 refuses an array update
      // without it (`Cannot pass an array to query updates unless the 'updatePipeline' option is
      // set`), which surfaces as a 500 on DELETE, not a type error. A mocked model accepts the
      // two-argument call happily, so the unit spec below asserts this third argument explicitly
      // — that assertion is the only thing standing between a passing suite and a broken endpoint.
      await this.conflictModel.updateMany(
        { tenantId, factIds: { $in: factIds } },
        [{ $set: { factIds: { $setDifference: ['$factIds', factIds] } } }],
        { updatePipeline: true },
      );

      // Resolved-as-superseded, never deleted, so a reviewer who later opens the conflicts list
      // still sees why it stopped being open. Scoped to `status: 'open'` only — a conflict a human
      // already decided (`resolved`/`dismissed`) keeps its recorded outcome; only the pull above
      // touches its `factIds`. A conflict the pull left with `>= MIN_CONFLICTING_FACTS` references
      // stays `open` — two or more facts still disagree, so there is still something for a
      // reviewer to decide.
      await this.conflictModel.updateMany(
        {
          tenantId,
          status: 'open',
          $expr: { $lt: [{ $size: '$factIds' }, MIN_CONFLICTING_FACTS] },
        },
        { status: 'resolved', resolution: { outcome: 'superseded', resolvedAt: new Date() } },
      );
    }

    await this.extractedFactModel.deleteMany({
      documentVersionId: { $in: versionIds },
      tenantId,
    });
    await this.evidenceChunkModel.deleteMany({ documentId: document._id, tenantId });

    // GridFS is a driver-level bucket the tenant-scope plugin cannot reach (same reasoning as
    // `addVersion`'s `put` call) — each version's bytes are removed individually via its own
    // `storageKey`, the only handle the store recognizes.
    for (const version of versions) {
      await this.documentStore.delete(version.storageKey);
    }

    await this.documentVersionModel.deleteMany({ documentId: document._id, tenantId });

    // Deliberate second pass, not accidental duplication — `remove()` takes no lease and does not
    // cancel an in-flight ingest workflow, so `IngestionService.ingestVersion`'s `insertMany` can
    // land new chunks (and `FactsService`'s extraction can land new facts) for this same
    // `documentVersionId` between the first deleteMany above and here. Re-running both deletes
    // after the version rows are gone closes that race window: anything a concurrent writer
    // inserted is still `tenantId`+`documentId`/`documentVersionId`-scoped and gets swept too, so a
    // deleted document's evidence never stays retrievable by the QA `$search`/`$vectorSearch` path.
    await this.extractedFactModel.deleteMany({
      documentVersionId: { $in: versionIds },
      tenantId,
    });
    await this.evidenceChunkModel.deleteMany({ documentId: document._id, tenantId });

    await this.documentModel.deleteOne({ _id: document._id, tenantId });

    await this.auditService.record({
      action: 'documents.deleted',
      actorId,
      subject: { entityType: 'Document', entityId: document._id.toString() },
      tenantId,
    });

    this.logger.debug(`Deleted document '${document._id.toString()}' and its cascade`);
  }

  // The cross-tenant attach this scoping exists to close: `documentId` arrives in the upload body
  // from the caller, so without the tenant predicate here a caller could attach a new version to
  // another tenant's document. `findOne` with the predicate, not `findById` plus a separate
  // ownership check, keeps a cross-tenant id indistinguishable from a missing one.
  private async requireDocument(documentId: string, tenantId: string): Promise<DocumentDocument> {
    if (!Types.ObjectId.isValid(documentId)) {
      throw new DocumentNotFoundException(`Document '${documentId}' not found`);
    }
    const document = await this.documentModel.findOne({ _id: documentId, tenantId });
    if (!document) {
      throw new DocumentNotFoundException(`Document '${documentId}' not found`);
    }
    return document;
  }

  /**
   * The tenant-wide half of the dedupe invariant: within a tenant, one sha256 identifies exactly
   * one `DocumentVersion`, so a hit here always wins over either write path. `callerDocument` is
   * the document the caller named via `dto.documentId` (`undefined` on a browser upload creating a
   * new document, or when re-run after an `addVersion`/`createDocument` race lost the unique
   * index).
   *
   * A hit records the caller's location on the owning document and reinstates it if withdrawn.
   * When the caller named a different document than the owner — the caller's document converges
   * onto bytes another document already holds — the caller's location is forgotten there instead,
   * and that document withdrawn once no location of its own remains.
   */
  private async resolveTenantWideDuplicate(
    sha256: string,
    callerLocation: DocumentLocationKey,
    callerDocument: DocumentDocument | undefined,
    tenantId: string,
  ): Promise<UploadOutcome | undefined> {
    const existing = await this.documentVersionModel.findOne({ tenantId, sha256 });
    if (!existing) {
      return undefined;
    }

    const owner =
      callerDocument && callerDocument._id.equals(existing.documentId)
        ? callerDocument
        : await this.documentModel.findOne({ _id: existing.documentId, tenantId });
    if (!owner) {
      // A version whose owning document does not resolve is corruption, not a normal miss — same
      // reasoning as `lookupVersions`' identical join.
      throw new InternalServerErrorException(
        `Document version '${existing._id.toString()}' references document '${existing.documentId.toString()}', which no longer exists`,
      );
    }

    // `recordLocation` writes through the driver, bypassing `owner`'s in-memory copy — the caller's
    // location must be visible on the document this method returns, so `owner` is re-read rather
    // than trusted stale, the same corruption reasoning as the lookup above.
    await this.recordLocation(owner._id, callerLocation, tenantId);
    const refreshedOwner = await this.documentModel.findOne({ _id: owner._id, tenantId });
    if (!refreshedOwner) {
      throw new InternalServerErrorException(
        `Document '${owner._id.toString()}' no longer exists after recording a dedupe location`,
      );
    }

    if (existing.withdrawnAt) {
      await this.reinstateVersions([refreshedOwner._id], tenantId);
    }

    if (callerDocument && !callerDocument._id.equals(refreshedOwner._id)) {
      const remaining = await this.forgetLocation(callerDocument._id, callerLocation, tenantId);
      if (remaining === 0) {
        await this.withdrawVersions([callerDocument._id], 'source-file-absent', tenantId);
      }
    }

    return { document: refreshedOwner, currentVersion: existing, isNewVersion: false };
  }

  /**
   * Records a sighting of `location` on `documentId`, unless one already carries the same key —
   * see {@link locationKeyMatch}. Single atomic `updateOne`: the query's `$not: { $elemMatch }`
   * clause only matches when no element already carries the key, so a second call with the same
   * key is a no-op rather than a duplicate push.
   */
  async recordLocation(
    documentId: Types.ObjectId,
    location: DocumentLocationKey,
    tenantId: string,
  ): Promise<void> {
    await this.documentModel.updateOne(
      {
        _id: documentId,
        tenantId,
        locations: { $not: { $elemMatch: this.locationKeyMatch(location) } },
      },
      { $push: { locations: { ...location, firstSeenAt: new Date() } } },
    );
  }

  /** Removes the location matching `key` from `documentId`'s `locations`, and returns how many
   * remain — `resolveTenantWideDuplicate`'s converge branch and `SourcesService.runSync`'s
   * withdrawal guard both read this count to decide whether the document has anywhere left it was
   * seen. */
  async forgetLocation(
    documentId: Types.ObjectId,
    key: DocumentLocationKey,
    tenantId: string,
  ): Promise<number> {
    const document = await this.documentModel.findOneAndUpdate(
      { _id: documentId, tenantId },
      { $pull: { locations: this.locationKeyMatch(key) } },
      { returnDocument: 'after' },
    );
    if (!document) {
      throw new DocumentNotFoundException(`Document '${documentId.toString()}' not found`);
    }
    return document.locations.length;
  }

  // Identifies one `DocumentLocation` by `(path, sourceId?, emailOrigin.parentVersionId+partIndex)`
  // — `messageId`/`from`/`sentAt`/`attachmentFilename` are provenance, not identity, so they play
  // no part in the match. `$exists: false` on an absent field, rather than omitting it: an omitted
  // key constrains nothing, which would let a sourced location match a sourceless one sharing the
  // same path.
  private locationKeyMatch(location: DocumentLocationKey): Record<string, unknown> {
    return {
      path: location.path,
      ...(location.sourceId ? { sourceId: location.sourceId } : { sourceId: { $exists: false } }),
      ...(location.emailOrigin
        ? {
            'emailOrigin.parentVersionId': location.emailOrigin.parentVersionId,
            'emailOrigin.partIndex': location.emailOrigin.partIndex,
          }
        : { emailOrigin: { $exists: false } }),
    };
  }

  /**
   * Adds a version to `document`, or — invariant: a document is withdrawn exactly when its last
   * known location is gone — mints a whole new document instead when `document` has more than one
   * location. A location shared with another only because both once held identical bytes stops
   * being a copy the moment one of them changes, so the caller's location is forgotten off
   * `document` and re-created on a fresh document carrying the new bytes through `createDocument`
   * (same `source`). The `> 1` precondition guarantees at least one location survives the forget,
   * so `document` itself is never withdrawn by this branch — only `resolveTenantWideDuplicate`'s
   * converge branch and `SourcesService.runSync`'s absence handling ever withdraw on the last
   * location.
   */
  private async addVersion(
    document: DocumentDocument,
    dto: UploadDocumentRequestDto,
    sourceKind: DocumentSourceKind,
    sha256: string,
    file: UploadedFileLike,
    canonicalMimeType: string,
    tenantId: string,
    source: UploadSourceOptions | undefined,
    callerLocation: DocumentLocationKey,
  ): Promise<UploadOutcome> {
    if (document.locations.length > 1) {
      await this.forgetLocation(document._id, callerLocation, tenantId);
      return this.createDocument(
        dto,
        sourceKind,
        sha256,
        file,
        canonicalMimeType,
        tenantId,
        source,
        callerLocation,
      );
    }

    const versionCount = await this.documentVersionModel.countDocuments({
      documentId: document._id,
      tenantId,
    });
    // GridFS is a driver-level bucket, not a Mongoose model, so the tenant-scope plugin
    // structurally cannot reach it — the storage key is only discoverable through the
    // now-scoped `document_versions` row, and this metadata is the defence-in-depth marker.
    // `canonicalMimeType`, not `file.mimetype`: the store's content type is what
    // `ParserRegistry.resolve` exact-matches against downstream, so it must already be
    // disambiguated the same way `resolveUploadKind` disambiguated it for `sourceKind`.
    const stored = await this.documentStore.put({
      content: file.buffer,
      contentType: canonicalMimeType,
      metadata: { tenantId },
    });

    let version: DocumentVersionDocument;
    try {
      version = await this.documentVersionModel.create({
        documentId: document._id,
        versionNumber: versionCount + 1,
        sha256,
        sizeBytes: file.size,
        storageKey: stored.id,
        tenantId,
      });
    } catch (error) {
      // A concurrent upload of the same bytes can win the tenant-wide unique index between
      // `uploadVersion`'s dedupe check and this create — the losing writer's stored bytes are
      // orphaned and must go, then this re-takes the dedupe branch its rival just created.
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      await this.documentStore.delete(stored.id);
      const dedupe = await this.resolveTenantWideDuplicate(
        sha256,
        callerLocation,
        document,
        tenantId,
      );
      if (!dedupe) {
        throw error;
      }
      return dedupe;
    }

    document.currentVersionId = version._id;
    await document.save();

    return { document, currentVersion: version, isNewVersion: true };
  }

  private async createDocument(
    dto: UploadDocumentRequestDto,
    sourceKind: DocumentSourceKind,
    sha256: string,
    file: UploadedFileLike,
    canonicalMimeType: string,
    tenantId: string,
    source: UploadSourceOptions | undefined,
    callerLocation: DocumentLocationKey,
  ): Promise<UploadOutcome> {
    const title = dto.title ?? file.originalname;
    if (!title.trim()) {
      throw new BadRequestException('title is required when creating a new document');
    }

    // `canonicalMimeType`, not `file.mimetype` — see the identical `contentType` comment on the
    // `documentStore.put` call below; the document row and the stored bytes must agree on the
    // disambiguated MIME, not the browser's raw (possibly ambiguous) one.
    // `sourceClass`/`sourceId` each omitted (not `undefined`-assigned) when the caller has none —
    // an explicit `undefined` would defeat `sourceClass`'s schema default, which applies only
    // when the key is absent from the create payload, and `sourceId` has no default to defeat but
    // the same conditional-spread shape keeps both fields consistent.
    const document = await this.documentModel.create({
      title,
      sourceKind,
      mimeType: canonicalMimeType,
      tenantId,
      ...(source?.sourceClass ? { sourceClass: source.sourceClass } : {}),
      ...(source?.sourceId ? { sourceId: source.sourceId } : {}),
      ...(source?.emailOrigin ? { emailOrigin: source.emailOrigin } : {}),
      locations: [{ ...callerLocation, firstSeenAt: new Date() }],
    });

    // See the identical GridFS metadata comment in `addVersion` above.
    const stored = await this.documentStore.put({
      content: file.buffer,
      contentType: canonicalMimeType,
      metadata: { tenantId },
    });

    let version: DocumentVersionDocument;
    try {
      version = await this.documentVersionModel.create({
        documentId: document._id,
        versionNumber: 1,
        sha256,
        sizeBytes: file.size,
        storageKey: stored.id,
        tenantId,
      });
    } catch (error) {
      // Same race as `addVersion`'s catch, one step earlier: this document row was just created
      // for bytes that turned out to already exist elsewhere in the tenant, so it — not only the
      // stored bytes — is the orphan to clean up.
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      await this.documentStore.delete(stored.id);
      await this.documentModel.deleteOne({ _id: document._id, tenantId });
      const dedupe = await this.resolveTenantWideDuplicate(
        sha256,
        callerLocation,
        undefined,
        tenantId,
      );
      if (!dedupe) {
        throw error;
      }
      return dedupe;
    }

    document.currentVersionId = version._id;
    await document.save();

    return { document, currentVersion: version, isNewVersion: true };
  }

  // A document created by this service always gets `currentVersionId` set in the same call that
  // creates it (`createDocument`/`addVersion`), so a document whose current version can't be
  // resolved is a data-integrity fault, not a normal branch — surfaced as a 500 rather than
  // silently dropped from a list or returned with a missing field.
  private assertCurrentVersion(
    document: DocumentDocument,
    currentVersion: DocumentVersionDocument | undefined,
  ): DocumentVersionDocument {
    if (!currentVersion) {
      throw new InternalServerErrorException(
        `Document '${document._id.toString()}' has no resolvable current version`,
      );
    }
    return currentVersion;
  }

  private toDocumentDto(
    document: DocumentDocument,
    currentVersion: DocumentVersionDocument,
  ): DocumentResponseDto {
    return {
      id: document._id.toString(),
      title: document.title,
      sourceKind: document.sourceKind,
      mimeType: document.mimeType,
      sourceClass: document.sourceClass,
      currentVersion: this.toVersionDto(currentVersion),
      locations: document.locations.map((location) => this.toLocationDto(location)),
      createdAt: document.createdAt,
    };
  }

  private toLocationDto(location: DocumentLocation): DocumentLocationResponseDto {
    return {
      path: location.path,
      // Key omitted, not `undefined`-assigned, when absent — an `undefined`-valued key still
      // shows up in an object-key-set assertion (`Object.keys`), which the serialization e2e for
      // this shape checks; the version DTO's `ingestionFailureReason` field takes the assignment
      // form instead because nothing there checks its key set the same way.
      ...(location.sourceId ? { sourceId: location.sourceId.toString() } : {}),
      firstSeenAt: location.firstSeenAt,
    };
  }

  private toVersionDto(version: DocumentVersionDocument): DocumentVersionResponseDto {
    return {
      id: version._id.toString(),
      versionNumber: version.versionNumber,
      sha256: version.sha256,
      sizeBytes: version.sizeBytes,
      // The observable marker for the ingestion workflow this version's upload just started —
      // 'pending' until the worker's `finalizeCompletion` flips it (`IngestionService`).
      ingestionStatus: version.ingestionStatus,
      /**
       * Carried explicitly because this mapping is hand-built: `@Expose()` on the DTO field only
       * governs what survives serialization, so a field missing from the object handed to
       * `toResponseDto` is absent from the payload no matter how it is decorated. Undefined while
       * the status is anything other than `'failed'`, and JSON omits the key entirely then.
       */
      ingestionFailureReason: version.ingestionFailureReason,
      // Same hand-built-mapping trap as `ingestionFailureReason` above: `@Expose()` alone cannot
      // surface a field this method never puts on the object it returns. Populated at ingest
      // (`IngestionService`/parser fidelity checks); this is only where it becomes visible to an
      // operator rather than sitting unread on the stored document.
      reducedFidelityReasons: version.reducedFidelityReasons,
      createdAt: version.createdAt,
    };
  }

  private toChunkDto(chunk: EvidenceChunkDocument): EvidenceChunkResponseDto {
    return {
      id: chunk._id,
      // The stored chunk stays byte-faithful to its source (`sanitizeEvidenceText`'s own
      // guarantee); this is the human-viewer boundary where display-only neutralization —
      // stripping control/bidi/zero-width characters — belongs instead, per
      // `neutralizeForDisplay`'s own doc comment.
      text: neutralizeForDisplay(chunk.text),
      tokenCount: chunk.tokenCount,
      locator: chunk.locator,
    };
  }

  // Normalizes every locator variant to a single comparable string, zero-padding the numeric
  // variants so lexicographic order matches numeric order (page 2 before page 10). Two chunks of
  // *different* locator kinds still compare via this same string — that never happens for a real
  // version (see `listVersionChunks`'s parser-homogeneity comment), so no separate kind-mismatch
  // branch exists; falling through to a plain string comparison keeps this total rather than
  // throwing if that assumption is ever violated.
  private locatorSortKey(locator: EvidenceLocator): string {
    switch (locator.kind) {
      case 'pdf-page':
        return `${locator.kind}:${locator.page.toString().padStart(10, '0')}`;
      case 'docx-paragraph':
        return `${locator.kind}:${locator.paragraphIndex.toString().padStart(10, '0')}`;
      case 'xlsx-region':
        return `${locator.kind}:${locator.range}`;
      case 'xlsx-cell':
        return `${locator.kind}:${locator.cell}`;
      case 'text-block':
        return `${locator.kind}:${locator.blockIndex.toString().padStart(10, '0')}`;
      case 'pptx-slide':
        return `${locator.kind}:${locator.slide.toString().padStart(10, '0')}`;
    }
  }
}
