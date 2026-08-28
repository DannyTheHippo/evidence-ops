import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { DocumentVersionDocument } from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  Document,
  type DocumentDocument,
} from '../../../database/schemas/evidence/document/document.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { contentMatchesDeclaredKind, resolveUploadKind } from '../documents/documents.constant';
import { DocumentsService } from '../documents/documents.service';
import { HostileEmailException } from './exceptions/ingestion.exception';
import { parseEmailMessage } from './parsers/email-mime';

export interface EmailUnwrapResult {
  /** Attachments this call turned into documents. Excludes ones an earlier attempt already
   * created. */
  readonly created: number;
  /** One entry per attachment or part that produced no document, naming why — the operator-visible
   * half of "an attachment is never dropped quietly". */
  readonly skippedReasons: readonly string[];
}

/**
 * Turns each attachment of an ingested `.eml` into a `Document` of its own.
 *
 * This is what keeps the locator contract intact across the container: an attachment becomes an
 * ordinary document, ingested by the ordinary pipeline, so a spreadsheet that arrived by email
 * cites `xlsx-cell` exactly as an uploaded one does. Provenance is not lost in exchange — every
 * document created here carries a `DocumentEmailOrigin` naming the message it came out of.
 *
 * Runs inside the ingest activity rather than at the upload gate, so a container refusal reaches
 * the same visible terminal state (`ingestionStatus: 'failed'` with a reason) that every other
 * container failure in this pipeline already reaches.
 */
@Injectable()
export class EmailAttachmentService {
  constructor(
    @InjectModel(Document.name)
    private readonly documentModel: Model<DocumentDocument>,

    private readonly documentsService: DocumentsService,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(EmailAttachmentService.name);
  }

  /**
   * Unwraps `content` — the `.eml` bytes of `version` — into one document per attachment.
   *
   * FAILURE DIRECTION: CLOSED on identity and on the container limits, OPEN on formats. An
   * attachment whose declared type contradicts its own bytes fails the whole message, because a
   * container that lies about one part has said nothing trustworthy about any of them, and a
   * message that crosses a limit in `parseEmailMessage` never reaches this loop at all. An
   * attachment this product simply has no parser for is skipped with a recorded reason instead —
   * rejecting those would fail every real email that carries a signature image, and a skip creates
   * no document either way.
   *
   * Idempotent under the at-least-once retries of the ingest activity: an attachment is identified
   * by `(tenantId, parentVersionId, partIndex)`, checked here before creating and enforced by the
   * unique index of the same shape, so a second attempt reuses what the first created rather than
   * minting a duplicate. Two attempts racing past the check collide on that index; the losing
   * attempt fails and its retry finds the row.
   *
   * An attachment inherits no `sourceClass` and no `sourceId` from the email. It is not a file any
   * connector saw, and the email is its origin — which is what `emailOrigin` records.
   */
  async unwrapAttachments(
    version: DocumentVersionDocument,
    content: Buffer,
  ): Promise<EmailUnwrapResult> {
    const message = parseEmailMessage(content);
    const skippedReasons = [...message.skippedPartReasons];
    let created = 0;

    for (const attachment of message.attachments) {
      const sourceKind = resolveUploadKind(attachment.declaredMimeType, attachment.filename);
      if (!sourceKind) {
        skippedReasons.push(
          `Attachment '${attachment.filename}' declares content type '${attachment.declaredMimeType}', which resolves to no supported document type`,
        );
        continue;
      }

      // The same sniff a direct upload of these bytes would face, called through the same function
      // — an attachment is not trusted because the message vouched for it.
      if (!contentMatchesDeclaredKind(attachment.content, sourceKind)) {
        throw new HostileEmailException(
          `Attachment '${attachment.filename}' declares content type '${attachment.declaredMimeType}' (resolved to '${sourceKind}'), but its bytes do not match that format`,
        );
      }

      const alreadyUnwrapped = await this.documentModel.findOne({
        tenantId: version.tenantId,
        'emailOrigin.parentVersionId': version._id,
        'emailOrigin.partIndex': attachment.partIndex,
      });
      if (alreadyUnwrapped) {
        this.logger.debug(
          `Attachment ${attachment.partIndex} of document version '${version._id.toString()}' was already unwrapped; skipping`,
        );
        continue;
      }

      await this.documentsService.upload(
        {
          originalname: attachment.filename,
          mimetype: attachment.declaredMimeType,
          size: attachment.content.length,
          buffer: attachment.content,
        },
        { title: attachment.filename },
        version.tenantId,
        {
          emailOrigin: {
            parentVersionId: version._id,
            parentDocumentId: version.documentId,
            partIndex: attachment.partIndex,
            attachmentFilename: attachment.filename,
            messageId: message.envelope.messageId,
            from: message.envelope.from,
            sentAt: message.envelope.sentAt,
          },
        },
      );
      created += 1;
    }

    if (skippedReasons.length > 0) {
      this.logger.debug(
        `Document version '${version._id.toString()}' unwrapped ${created} attachment(s); ${skippedReasons.length} part(s) skipped`,
      );
    }

    return { created, skippedReasons };
  }
}
