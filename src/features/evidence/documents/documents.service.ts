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
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
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
}

@Injectable()
export class DocumentsService {
  constructor(
    @InjectModel(Document.name)
    private readonly documentModel: Model<DocumentDocument>,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @Inject(DOCUMENT_STORE)
    private readonly documentStore: DocumentStore,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(DocumentsService.name);
  }

  async upload(
    file: UploadedFileLike | undefined,
    dto: UploadDocumentRequestDto,
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

    const { document, currentVersion } = dto.documentId
      ? await this.addVersion(dto.documentId, sha256, file)
      : await this.createDocument(dto, sourceKind, sha256, file);

    this.logger.debug(
      `Document '${document._id.toString()}' upload resolved to version '${currentVersion._id.toString()}'`,
    );

    return this.toDocumentDto(document, currentVersion);
  }

  async list(
    pagination: PaginationRequestDto,
  ): Promise<DocumentResultWithCount<DocumentResponseDto>> {
    const filter = { tenantId: DEFAULT_TENANT_ID };

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

  async getById(id: string): Promise<DocumentWithVersionsResponseDto> {
    if (!Types.ObjectId.isValid(id)) {
      throw new DocumentNotFoundException(`Document '${id}' not found`);
    }

    const document = await this.documentModel.findById(id);
    if (!document) {
      throw new DocumentNotFoundException(`Document '${id}' not found`);
    }

    const versions = await this.documentVersionModel
      .find({ documentId: document._id })
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
  ): Promise<UploadResult> {
    if (!Types.ObjectId.isValid(documentId)) {
      throw new DocumentNotFoundException(`Document '${documentId}' not found`);
    }

    const document = await this.documentModel.findById(documentId);
    if (!document) {
      throw new DocumentNotFoundException(`Document '${documentId}' not found`);
    }

    const existingVersion = await this.documentVersionModel.findOne({
      documentId: document._id,
      sha256,
    });
    if (existingVersion) {
      // Content-addressed no-op: unchanged bytes never inflate the version chain, and the
      // response returns that existing version as-is. If the matched version predates the
      // document's actual current version (stale bytes re-uploaded), this does NOT move the
      // current pointer back — only a genuinely new hash ever advances `currentVersionId`.
      return { document, currentVersion: existingVersion };
    }

    const versionCount = await this.documentVersionModel.countDocuments({
      documentId: document._id,
    });
    const stored = await this.documentStore.put({
      content: file.buffer,
      contentType: file.mimetype,
      metadata: {},
    });

    const version = await this.documentVersionModel.create({
      documentId: document._id,
      versionNumber: versionCount + 1,
      sha256,
      sizeBytes: file.size,
      storageKey: stored.id,
      tenantId: DEFAULT_TENANT_ID,
    });

    document.currentVersionId = version._id;
    await document.save();

    return { document, currentVersion: version };
  }

  private async createDocument(
    dto: UploadDocumentRequestDto,
    sourceKind: DocumentSourceKind,
    sha256: string,
    file: UploadedFileLike,
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
      tenantId: DEFAULT_TENANT_ID,
    });

    const stored = await this.documentStore.put({
      content: file.buffer,
      contentType: file.mimetype,
      metadata: {},
    });

    const version = await this.documentVersionModel.create({
      documentId: document._id,
      versionNumber: 1,
      sha256,
      sizeBytes: file.size,
      storageKey: stored.id,
      tenantId: DEFAULT_TENANT_ID,
    });

    document.currentVersionId = version._id;
    await document.save();

    return { document, currentVersion: version };
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
      createdAt: version.createdAt,
    };
  }
}
