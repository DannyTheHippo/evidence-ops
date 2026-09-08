import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model } from 'mongoose';
import type { DocumentVersionIngestionStatus } from '../../../database/schemas/evidence/document-version/document-version.schema';
import { Source, SourceDocument } from '../../../database/schemas/evidence/source/source.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import {
  AMBIGUOUS_UPLOAD_MIME_TYPES,
  contentMatchesDeclaredKind,
  resolveUploadKind,
} from '../documents/documents.constant';
import { DocumentsService } from '../documents/documents.service';
import {
  ContentTypeMismatchException,
  UnresolvableContentTypeException,
  UnsupportedContentTypeException,
} from '../documents/exceptions/documents.exception';
import {
  InvalidBase64ContentException,
  SubmissionTooLargeException,
  SubmitSourceKindConflictException,
} from './exceptions/sources.exception';

/** Caps the raw base64 string, not the decoded byte count — checked before `Buffer.from` ever
 *  runs, so an oversized payload is refused without paying for the decode it would otherwise cost. */
export const SUBMIT_EVIDENCE_MAX_BASE64_CHARS = 20 * 1024 * 1024;

export const DEFAULT_MCP_SUBMIT_SOURCE_NAME = 'MCP submissions';

// RFC 4648 base64 (no URL-safe variant, since neither the tool schema nor any client documented
// here produces one): letters/digits/`+`/`/`, with 0-2 trailing `=` pad characters. Matches the
// empty string too — that case is refused after decoding instead (see the zero-byte check below),
// since every non-empty string this pattern accepts, at a length divisible by four, decodes to at
// least one byte.
const BASE64_CHARSET_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export interface SubmitEvidenceInput {
  readonly filename: string;
  readonly mimeType: string;
  readonly contentBase64: string;
  readonly sourceLabel?: string;
  readonly tenantId: string;
}

export interface SubmitEvidenceResult {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly sha256: string;
  readonly ingestionStatus: DocumentVersionIngestionStatus;
  readonly isNewVersion: boolean;
  readonly sourceId: string;
}

/**
 * `submit_evidence`'s REST-upload parity path: an MCP caller's base64 bytes reach the same
 * `resolveUploadKind`/`contentMatchesDeclaredKind`/sha256/`DocumentsService.uploadVersion` gate a
 * browser upload does, attributed to a dedicated `mcp-submit` source rather than a browser's
 * document-relative location.
 */
@Injectable()
export class EvidenceSubmissionService {
  constructor(
    private readonly documentsService: DocumentsService,

    @InjectModel(Source.name)
    private readonly sourceModel: Model<SourceDocument>,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(EvidenceSubmissionService.name);
  }

  async submit(input: SubmitEvidenceInput): Promise<SubmitEvidenceResult> {
    // Fails CLOSED, in this order, before any I/O: the size cap first (refuses a payload
    // proportional to the cap without decoding it), then the charset/padding shape, then the
    // decode itself, then this zero-byte check — each check runs only once everything cheaper
    // than it has already passed.
    this.assertBase64Shape(input.contentBase64);
    const buffer = Buffer.from(input.contentBase64, 'base64');
    if (buffer.length === 0) {
      throw new InvalidBase64ContentException(
        `Submission '${input.filename}' decoded to zero bytes`,
      );
    }

    // Same content-identity gate a direct REST upload faces (`DocumentsService.uploadVersion`):
    // the declared `mimeType` is never trusted on its own, and a magic-byte mismatch is refused
    // before the source row or any document write exists.
    const sourceKind = resolveUploadKind(input.mimeType, input.filename);
    if (!sourceKind) {
      if (AMBIGUOUS_UPLOAD_MIME_TYPES.has(input.mimeType.toLowerCase())) {
        throw new UnresolvableContentTypeException(
          `Could not resolve a document type for '${input.filename}' with ambiguous content type '${input.mimeType}'`,
        );
      }
      throw new UnsupportedContentTypeException(
        `Unsupported content type '${input.mimeType}' for file '${input.filename}'`,
      );
    }
    if (!contentMatchesDeclaredKind(buffer, sourceKind)) {
      throw new ContentTypeMismatchException(
        `File '${input.filename}' was declared as content type '${input.mimeType}' (resolved to '${sourceKind}'), but its bytes do not match that format`,
      );
    }

    const source = await this.findOrCreateSubmitSource(input.sourceLabel, input.tenantId);

    const outcome = await this.documentsService.uploadVersion(
      { originalname: input.filename, mimetype: input.mimeType, size: buffer.length, buffer },
      {},
      input.tenantId,
      { sourceId: source._id, path: input.filename },
    );

    // Recomputed on the received buffer rather than read off `outcome`: the dedupe path can
    // return another tenant document's existing version, whose own sha256 already equals this
    // one, but the tool's response is documented as describing the bytes the caller sent.
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    return {
      documentId: outcome.document._id.toString(),
      documentVersionId: outcome.currentVersion._id.toString(),
      sha256,
      ingestionStatus: outcome.currentVersion.ingestionStatus,
      isNewVersion: outcome.isNewVersion,
      sourceId: source._id.toString(),
    };
  }

  private assertBase64Shape(contentBase64: string): void {
    if (contentBase64.length > SUBMIT_EVIDENCE_MAX_BASE64_CHARS) {
      throw new SubmissionTooLargeException(
        `Submission of ${contentBase64.length} base64 characters exceeds the ${SUBMIT_EVIDENCE_MAX_BASE64_CHARS} cap`,
      );
    }
    if (contentBase64.length % 4 !== 0 || !BASE64_CHARSET_PATTERN.test(contentBase64)) {
      throw new InvalidBase64ContentException('contentBase64 is not well-formed base64');
    }
  }

  /**
   * `Source.name` is `trim: true`, so an untrimmed label would miss both the lookup and the
   * unique index it collides with on create — trimming here first keeps the two in agreement.
   * A `code === 11000` create race is re-resolved with one more `findOne`, mirroring
   * `DocumentsService`'s identical dedupe-race pattern; a second miss re-throws the original
   * error rather than retrying indefinitely.
   */
  private async findOrCreateSubmitSource(
    sourceLabel: string | undefined,
    tenantId: string,
  ): Promise<SourceDocument> {
    const name = (sourceLabel ?? DEFAULT_MCP_SUBMIT_SOURCE_NAME).trim();

    const existing = await this.sourceModel.findOne({ tenantId, name });
    if (existing) {
      this.assertSubmitKind(existing);
      return existing;
    }

    try {
      return await this.sourceModel.create({
        name,
        kind: 'mcp-submit',
        path: name,
        enabled: true,
        tracked: false,
        connectivity: 'manual',
        reachability: 'live',
        sourceClass: 'unclassified',
        tenantId,
      });
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }
      const raced = await this.sourceModel.findOne({ tenantId, name });
      if (!raced) {
        throw error;
      }
      this.assertSubmitKind(raced);
      return raced;
    }
  }

  // A row found under this name that is not `mcp-submit` was created by `POST /sources` (or a
  // pre-existing connector) — the submission must not attach itself to a source it does not own.
  private assertSubmitKind(source: SourceDocument): void {
    if (source.kind !== 'mcp-submit') {
      throw new SubmitSourceKindConflictException(
        `Source '${source.name}' already exists with kind '${source.kind}', not 'mcp-submit'`,
      );
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
