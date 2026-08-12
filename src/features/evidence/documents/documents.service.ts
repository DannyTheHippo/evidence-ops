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
import { catchError, concatMap, distinctUntilChanged, map, merge, of, timer } from 'rxjs';
import { DEFAULT_TENANT_ID } from '../../../database/constants/tenant.constant';
import {
  Conflict,
  ConflictDocument,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import type { DocumentSourceKind } from '../../../database/schemas/evidence/document/document.schema';
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
  DEFAULT_PAGINATION_LIMIT,
  DEFAULT_PAGINATION_SKIP,
} from '../../../shared/constants/pagination-defaults.constant';
import { SSE_HEARTBEAT_INTERVAL_MS } from '../../../shared/constants/sse.constant';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import type { IngestDocumentVersionInput } from '../../../workflows/types';
import { DOCUMENTS_STREAM_INTERVAL_MS, MIME_TYPE_TO_SOURCE_KIND } from './documents.constant';
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

    @Inject(DOCUMENT_STORE)
    private readonly documentStore: DocumentStore,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

    private readonly auditService: AuditService,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(DocumentsService.name);
  }

  async upload(
    file: UploadedFileLike | undefined,
    dto: UploadDocumentRequestDto,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<DocumentResponseDto> {
    if (!file) {
      throw new MissingFileException('A file is required');
    }

    // Input gate, fails CLOSED: anything outside the allowlist is rejected before any I/O
    // (hashing, storage write) happens, regardless of new-document vs new-version.
    const sourceKind = MIME_TYPE_TO_SOURCE_KIND[file.mimetype];
    if (!sourceKind) {
      throw new UnsupportedContentTypeException(
        `Unsupported content type '${file.mimetype}'; expected one of pdf, docx, xlsx`,
      );
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    const { document, currentVersion, isNewVersion } = dto.documentId
      ? await this.addVersion(dto.documentId, sha256, file, tenantId)
      : await this.createDocument(dto, sourceKind, sha256, file, tenantId);

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
    tenantId: string = DEFAULT_TENANT_ID,
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
   * No `peekList`/`list` split, unlike `qa`/`workflow-runs`/`approvals`: `list` above never
   * records an audit row to begin with (unlike `getAnswerById`/`findById`/`listPending`), so there
   * is nothing this tick could over-record and nothing to gate an opening audit write on either —
   * this is the one stream of the three with no audit story at all.
   *
   * No terminal `takeWhile` either: unlike the answer/run streams, a document list has no terminal
   * state to close the connection on — it stays open until the client disconnects, which Nest's
   * `SseStream` already tears down via its own socket-close handling.
   */
  streamList(tenantId: string = DEFAULT_TENANT_ID): Observable<MessageEvent> {
    const documents$: Observable<DocumentsStreamEvent> = timer(
      0,
      DOCUMENTS_STREAM_INTERVAL_MS,
    ).pipe(
      concatMap(() =>
        this.list({ skip: DEFAULT_PAGINATION_SKIP, limit: DEFAULT_PAGINATION_LIMIT }, tenantId),
      ),
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
      map((event): MessageEvent => event),
      // FAIL OPEN TO POLLING — see `QaService.streamAnswer`'s identical reasoning: the SPA's
      // retained `listDocuments()` polling is the fallback.
      catchError((error) =>
        of<MessageEvent>({ type: 'error', data: { message: (error as Error).message } }),
      ),
    );
  }

  async getById(
    id: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<DocumentWithVersionsResponseDto> {
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
    tenantId: string = DEFAULT_TENANT_ID,
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
    tenantId: string = DEFAULT_TENANT_ID,
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
  async remove(id: string, actorId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<void> {
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

    // Only conflicts whose disagreement actually involved one of this document's facts are
    // touched — resolved-as-superseded, never deleted, so a reviewer who later opens the
    // conflicts list still sees why it stopped being open. Rides the `conflicts_tenantId_status_
    // factIds` compound index from migration 0006 (same `{ tenantId, status, factIds }` shape
    // `findConflictedFactGroupsForChunks` already queries).
    if (factIds.length > 0) {
      await this.conflictModel.updateMany(
        { tenantId, status: 'open', factIds: { $in: factIds } },
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
    const stored = await this.documentStore.put({
      content: file.buffer,
      contentType: file.mimetype,
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
    tenantId: string,
  ): Promise<UploadResult> {
    // Guards the type only: `UploadDocumentRequestDto.title` is required by `@ValidateIf`
    // whenever `documentId` is absent, so the global ValidationPipe already rejects a request
    // that reaches here without one (mirrors `AuthController.me()`'s guard-clause pattern).
    if (!dto.title) {
      throw new BadRequestException('title is required when creating a new document');
    }

    const document = await this.documentModel.create({
      title: dto.title,
      sourceKind,
      mimeType: file.mimetype,
      tenantId,
    });

    // See the identical GridFS metadata comment in `addVersion` above.
    const stored = await this.documentStore.put({
      content: file.buffer,
      contentType: file.mimetype,
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
    }
  }
}
