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
import { reauthTicks$ } from '../../../shared/utils/stream-session.util';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import type { IngestDocumentVersionInput } from '../../../workflows/types';
import {
  AMBIGUOUS_UPLOAD_MIME_TYPES,
  DOCUMENTS_STREAM_INTERVAL_MS,
  MIME_TYPE_TO_SOURCE_KIND,
  resolveUploadKind,
  SOURCE_KIND_TO_MIME_TYPE,
} from './documents.constant';
import type { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import { UploadDocumentRequestDto } from './dtos/request/upload-document.request.dto';
import { DocumentResponseDto } from './dtos/response/document.response.dto';
import { DocumentVersionResponseDto } from './dtos/response/document-version.response.dto';
import { DocumentWithVersionsResponseDto } from './dtos/response/document-with-versions.response.dto';
import { EvidenceChunkResponseDto } from './dtos/response/evidence-chunk.response.dto';
import {
  DocumentNotFoundException,
  DocumentVersionNotFoundException,
  MissingFileException,
  UnresolvableContentTypeException,
  UnsupportedContentTypeException,
} from './exceptions/documents.exception';
import { sanitizeDownloadFilename } from './sanitize-download-filename.util';
import type { UploadedFileLike } from './types/uploaded-file.type';

/** Return shape of `getVersionContent` — the bytes plus everything the controller needs to build
 * the download response, so the controller never has to re-derive a `Content-Type` or filename. */
export interface DocumentVersionContent {
  content: Buffer;
  contentType: string;
  filename: string;
}

interface UploadResult {
  document: DocumentDocument;
  currentVersion: DocumentVersionDocument;
  /** False on the content-addressed dedupe path (`addVersion` reusing an existing sha256) —
   * distinguishes "no new bytes were stored" from every path that actually created a version, so
   * `upload()` only ever starts ingestion for a version that needs it. */
  isNewVersion: boolean;
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
    // Not on `UploadDocumentRequestDto`: a browser upload has no source to inherit a class from,
    // only a connector sync (`SourcesService.syncOneFile`) knows the originating `Source`'s
    // `sourceClass` and passes it here for a new document to inherit.
    sourceClass?: DocumentSourceClass,
  ): Promise<DocumentResponseDto> {
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
    // The canonical MIME for the resolved kind, not the browser's raw `file.mimetype` — this is
    // what gets persisted and stored, so the parser registry's exact-match lookup
    // (`ParserRegistry.resolve`) never has to learn about a browser's lie either.
    const canonicalMimeType = SOURCE_KIND_TO_MIME_TYPE[sourceKind];

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    const { document, currentVersion, isNewVersion } = dto.documentId
      ? await this.addVersion(dto.documentId, sha256, file, canonicalMimeType, tenantId)
      : await this.createDocument(
          dto,
          sourceKind,
          sha256,
          file,
          canonicalMimeType,
          tenantId,
          sourceClass,
        );

    // Fire-and-forget, mirroring `QaService.startQuestion`: a slow parse/embed must never block
    // the upload response, which is the entire point of running ingestion as a durable workflow
    // rather than an inline call into `IngestionService`. Never starts for the dedupe path — no
    // new bytes were stored, so there is nothing new to ingest.
    if (isNewVersion) {
      await this.workflowEngine.start(INGEST_DOCUMENT_VERSION_WORKFLOW_TYPE, {
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
    }

    this.logger.debug(
      `Document '${document._id.toString()}' upload resolved to version '${currentVersion._id.toString()}'`,
    );

    return this.toDocumentDto(document, currentVersion);
  }

  async list(
    pagination: PaginationRequestDto,
    tenantId: string,
  ): Promise<DocumentResultWithCount<DocumentResponseDto>> {
    const filter = { tenantId };

    const [documents, count] = await Promise.all([
      this.documentModel.find(filter, null, {
        sort: { createdAt: -1 },
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
   * Polling-on-the-server, deliberately not a MongoDB change stream — see
   * `QaService.streamAnswer`'s identical rejected-alternative note.
   *
   * `pagination` is the caller's current `skip`/`limit`, threaded straight through to `list` —
   * this stream mirrors a list the caller is paging through (`list`'s `sort: {createdAt: -1}`
   * above), so stream and poll must agree on every page, not only the newest one. A hardcoded
   * newest-page window here is what used to force the SPA to disable the stream past page 1
   * (`DocumentList.tsx`'s former workaround); with the caller's own page threaded through instead,
   * that stopgap is no longer needed.
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
    // `$setDifference` can. Both stay tenant-scoped and rides the `conflicts_tenantId_status_
    // factIds` compound index from migration 0006 (same `{ tenantId, status, factIds }` shape
    // `findConflictedFactGroupsForChunks` already queries).
    if (factIds.length > 0) {
      // `updatePipeline: true` is REQUIRED, not decorative: Mongoose 9 refuses an array update
      // without it (`Cannot pass an array to query updates unless the 'updatePipeline' option is
      // set`), which surfaces as a 500 on DELETE, not a type error. A mocked model accepts the
      // two-argument call happily, so the unit spec below asserts this third argument explicitly —
      // that assertion is the only thing standing between a passing suite and a broken endpoint.
      await this.conflictModel.updateMany(
        { tenantId, status: 'open', factIds: { $in: factIds } },
        [{ $set: { factIds: { $setDifference: ['$factIds', factIds] } } }],
        { updatePipeline: true },
      );

      // Resolved-as-superseded, never deleted, so a reviewer who later opens the conflicts list
      // still sees why it stopped being open. A conflict the pull above left with
      // `>= MIN_CONFLICTING_FACTS` references stays `open` — two or more facts still disagree, so
      // there is still something for a reviewer to decide.
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

  private async addVersion(
    documentId: string,
    sha256: string,
    file: UploadedFileLike,
    canonicalMimeType: string,
    tenantId: string,
  ): Promise<UploadResult> {
    if (!Types.ObjectId.isValid(documentId)) {
      throw new DocumentNotFoundException(`Document '${documentId}' not found`);
    }

    // The cross-tenant attach this scoping exists to close: `documentId` arrives in the upload
    // body from the caller, so without the tenant predicate here a caller could attach a new
    // version to another tenant's document. `findOne` with the predicate, not `findById` plus a
    // separate ownership check, keeps a cross-tenant id indistinguishable from a missing one.
    const document = await this.documentModel.findOne({ _id: documentId, tenantId });
    if (!document) {
      throw new DocumentNotFoundException(`Document '${documentId}' not found`);
    }

    const existingVersion = await this.documentVersionModel.findOne({
      documentId: document._id,
      sha256,
      tenantId,
    });
    if (existingVersion) {
      // Content-addressed no-op: unchanged bytes never inflate the version chain, and the
      // response returns that existing version as-is. If the matched version predates the
      // document's actual current version (stale bytes re-uploaded), this does NOT move the
      // current pointer back — only a genuinely new hash ever advances `currentVersionId`.
      return { document, currentVersion: existingVersion, isNewVersion: false };
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

    const version = await this.documentVersionModel.create({
      documentId: document._id,
      versionNumber: versionCount + 1,
      sha256,
      sizeBytes: file.size,
      storageKey: stored.id,
      tenantId,
    });

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
    sourceClass?: DocumentSourceClass,
  ): Promise<UploadResult> {
    const title = dto.title ?? file.originalname;
    if (!title.trim()) {
      throw new BadRequestException('title is required when creating a new document');
    }

    // `canonicalMimeType`, not `file.mimetype` — see the identical `contentType` comment on the
    // `documentStore.put` call below; the document row and the stored bytes must agree on the
    // disambiguated MIME, not the browser's raw (possibly ambiguous) one.
    // `sourceClass` omitted (not `undefined`-assigned) when the caller has none — the schema's own
    // `default: 'unclassified'` applies only when the key is absent from the create payload.
    const document = await this.documentModel.create({
      title,
      sourceKind,
      mimeType: canonicalMimeType,
      tenantId,
      ...(sourceClass ? { sourceClass } : {}),
    });

    // See the identical GridFS metadata comment in `addVersion` above.
    const stored = await this.documentStore.put({
      content: file.buffer,
      contentType: canonicalMimeType,
      metadata: { tenantId },
    });

    const version = await this.documentVersionModel.create({
      documentId: document._id,
      versionNumber: 1,
      sha256,
      sizeBytes: file.size,
      storageKey: stored.id,
      tenantId,
    });

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
      currentVersion: this.toVersionDto(currentVersion),
      createdAt: document.createdAt,
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
      createdAt: version.createdAt,
    };
  }

  private toChunkDto(chunk: EvidenceChunkDocument): EvidenceChunkResponseDto {
    return {
      id: chunk._id,
      text: chunk.text,
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
