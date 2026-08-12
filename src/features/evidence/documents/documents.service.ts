import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../database/constants/tenant.constant';
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
  DOCUMENT_STORE,
  type DocumentStore,
} from '../../../providers/storage/document-store.interface';
import {
  WORKFLOW_ENGINE,
  type WorkflowEngine,
} from '../../../providers/workflow-engine/workflow-engine.interface';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import type { IngestDocumentVersionInput } from '../../../workflows/types';
import { MIME_TYPE_TO_SOURCE_KIND } from './documents.constant';
import type { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import { UploadDocumentRequestDto } from './dtos/request/upload-document.request.dto';
import { DocumentResponseDto } from './dtos/response/document.response.dto';
import { DocumentVersionResponseDto } from './dtos/response/document-version.response.dto';
import { DocumentWithVersionsResponseDto } from './dtos/response/document-with-versions.response.dto';
import {
  DocumentNotFoundException,
  MissingFileException,
  UnsupportedContentTypeException,
} from './exceptions/documents.exception';
import type { UploadedFileLike } from './types/uploaded-file.type';

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

@Injectable()
export class DocumentsService {
  constructor(
    @InjectModel(Document.name)
    private readonly documentModel: Model<DocumentDocument>,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @Inject(DOCUMENT_STORE)
    private readonly documentStore: DocumentStore,

    @Inject(WORKFLOW_ENGINE)
    private readonly workflowEngine: WorkflowEngine,

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
    const versions = await this.documentVersionModel.find({ _id: { $in: versionIds } });
    const versionById = new Map(versions.map((version) => [version._id.toString(), version]));

    const docs = documents.map((document) => {
      const currentVersion = document.currentVersionId
        ? versionById.get(document.currentVersionId.toString())
        : undefined;
      return this.toDocumentDto(document, this.assertCurrentVersion(document, currentVersion));
    });

    return { docs, count };
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
}
