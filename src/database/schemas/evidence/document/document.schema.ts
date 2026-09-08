import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type DocumentSourceKind =
  'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'tsv' | 'txt' | 'md' | 'eml' | 'html';

export const DOCUMENT_SOURCE_KINDS: readonly DocumentSourceKind[] = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'tsv',
  'txt',
  'md',
  'eml',
  'html',
];

/**
 * Which kind of source a document's content came from, for a later survivorship policy to weigh
 * one document's value over another's for the same fact (a CRM export outranks a memo for some
 * metrics, and the reverse for others). `Source.sourceClass` carries the same union for a
 * connector-ingested document to inherit from.
 */
export type DocumentSourceClass =
  'crm-export' | 'pm-export' | 'spreadsheet' | 'memo' | 'report' | 'unclassified';

export const DOCUMENT_SOURCE_CLASSES: readonly DocumentSourceClass[] = [
  'crm-export',
  'pm-export',
  'spreadsheet',
  'memo',
  'report',
  'unclassified',
];

/**
 * Where an attachment document came from, when its bytes were unwrapped out of an `.eml` rather
 * than uploaded or synced on their own (`EmailAttachmentService`). Absent on every other document,
 * including the `.eml` document itself — the email is the origin, it does not have one.
 *
 * `partIndex` is the attachment's ordinal within its parent message, counted over the parts the
 * MIME walk reached in order. Together with `parentVersionId` it identifies one attachment
 * uniquely, which is what makes unwrapping idempotent across the at-least-once retries of the
 * ingest activity that performs it.
 *
 * `messageId`, `from` and `sentAt` are copied from the parent message's headers and are therefore
 * sender-controlled text, recorded as provenance rather than trusted as identity: none of them is
 * used to resolve, dedupe, or authorize anything.
 */
@Schema({ _id: false })
export class DocumentEmailOrigin {
  @Prop({ type: Types.ObjectId, ref: 'DocumentVersion', required: true })
  parentVersionId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Document', required: true })
  parentDocumentId: Types.ObjectId;

  @Prop({ type: Number, required: true })
  partIndex: number;

  @Prop({ type: String })
  messageId?: string;

  @Prop({ type: String })
  from?: string;

  @Prop({ type: Date })
  sentAt?: Date;

  /** The attachment's own filename as the message declared it, sanitized for display. Never used
   * as a filesystem path — stored bytes are addressed by `DocumentVersion.storageKey`. */
  @Prop({ type: String, required: true })
  attachmentFilename: string;
}

export const DocumentEmailOriginSchema = SchemaFactory.createForClass(DocumentEmailOrigin);

/**
 * One place this document's current-version bytes have been seen: a browser upload's filename, a
 * connector's relative path, or the parent message an attachment was unwrapped from. Tenant-wide
 * content dedupe (`DocumentsService.uploadVersion`) is what populates and prunes this array —
 * `recordLocation` appends on a fresh sighting, `forgetLocation` removes one, and a document is
 * withdrawn exactly when its last location is gone.
 */
@Schema({ _id: false })
export class DocumentLocation {
  @Prop({ type: String, required: true })
  path: string;

  @Prop({ type: Types.ObjectId, ref: 'Source' })
  sourceId?: Types.ObjectId;

  @Prop({ type: DocumentEmailOriginSchema })
  emailOrigin?: DocumentEmailOrigin;

  @Prop({ type: Date, required: true })
  firstSeenAt: Date;
}

export const DocumentLocationSchema = SchemaFactory.createForClass(DocumentLocation);

export type DocumentDocument = HydratedDocument<WithTimestamps<Document>>;

@Schema({ timestamps: true, collection: 'documents' })
export class Document extends AuditableDocument {
  @Prop({ type: String, required: true, trim: true })
  title: string;

  // Routes which extractor pipeline parses this document. A document's locator kinds follow its
  // parser rather than a 1:1 prefix — csv and html both emit `xlsx-cell` locators, and html also
  // emits `text-block` — so a chunk's locator variant is predictable from the parser, not derived
  // from sourceKind by string prefix. Distinct from `mimeType`, which is the raw content type as
  // uploaded.
  @Prop({ type: String, required: true, enum: DOCUMENT_SOURCE_KINDS })
  sourceKind: DocumentSourceKind;

  @Prop({ type: String, required: true })
  mimeType: string;

  // String ref, not a class import: Document and DocumentVersion reference each other
  // (currentVersionId here, documentId there) and importing the classes both ways would create
  // a circular module dependency for no type-safety gain over the string-ref convention already
  // used by AuditableDocument's own `createdBy`/`updatedBy`.
  @Prop({ type: Types.ObjectId, ref: 'DocumentVersion' })
  currentVersionId?: Types.ObjectId;

  @Prop({ type: String, required: true })
  tenantId: string;

  /**
   * `'unclassified'` is a real, meaningful value, not a fallback to dodge a required field — it
   * means nobody has said what kind of source this document is, and a survivorship policy reading
   * this field must treat it as no authority information rather than as the lowest rank.
   */
  @Prop({
    type: String,
    required: true,
    enum: DOCUMENT_SOURCE_CLASSES,
    default: 'unclassified',
  })
  sourceClass: DocumentSourceClass;

  /**
   * The `Source` this document's bytes were ingested from, absent for a browser upload (no source
   * to attribute) and for a document created before this field existed and never touched by the
   * `0026-document-source-backlink` backfill's first-wins resolution. `DocumentsService.upload`
   * sets it going forward from the sync path and from an MCP submission (an `'mcp-submit'`
   * source, never synced) — a browser upload still has no source to attribute.
   */
  @Prop({ type: Types.ObjectId, ref: 'Source' })
  sourceId?: Types.ObjectId;

  /** Present only on a document unwrapped out of an email attachment — see
   * {@link DocumentEmailOrigin}. */
  @Prop({ type: DocumentEmailOriginSchema })
  emailOrigin?: DocumentEmailOrigin;

  /** Every place this document's current-version bytes have been seen, tenant-wide — see
   * {@link DocumentLocation}. Empty on a document predating this field. */
  @Prop({ type: [DocumentLocationSchema], default: [] })
  locations: DocumentLocation[];
}

export const DocumentSchema = SchemaFactory.createForClass(Document);

/**
 * Declared here as well as in `migrations/0001-baseline.ts`, with the same key
 * pattern, options and name — MongoDB refuses a second index on a key pattern it already carries
 * under a different name, and which side loses depends on boot order. Backs a future "documents
 * from this source" lookup without a collection scan.
 */
DocumentSchema.index({ tenantId: 1, sourceId: 1 }, { name: 'documents_tenantId_sourceId' });

/**
 * Declared here as well as in `migrations/0001-baseline.ts`, with the same key
 * pattern, options and name, for the same reason as the index above.
 *
 * Unique, and partial on `emailOrigin.parentVersionId` existing: it is what makes email-attachment
 * unwrapping idempotent across the at-least-once retries of the ingest activity that performs it,
 * while leaving every document without an `emailOrigin` out of the index entirely.
 */
DocumentSchema.index(
  { tenantId: 1, 'emailOrigin.parentVersionId': 1, 'emailOrigin.partIndex': 1 },
  {
    name: 'documents_emailOrigin_part_unique',
    unique: true,
    partialFilterExpression: { 'emailOrigin.parentVersionId': { $exists: true } },
  },
);

/**
 * Declared here as well as in `migrations/0001-baseline.ts`, with the same key pattern, options
 * and name, for the same reason as the index above. Not unique — a converged attachment forgets
 * its old location and grows a new one elsewhere, and two locations can carry the same
 * `emailOrigin` part only mid-transition. Backs `EmailAttachmentService.unwrapAttachments`'s
 * widened idempotency lookup, which now checks `locations.emailOrigin.*` alongside
 * `emailOrigin.*` on the document itself.
 */
DocumentSchema.index(
  {
    tenantId: 1,
    'locations.emailOrigin.parentVersionId': 1,
    'locations.emailOrigin.partIndex': 1,
  },
  {
    name: 'documents_locations_emailOrigin_part',
    partialFilterExpression: { 'locations.emailOrigin.parentVersionId': { $exists: true } },
  },
);

/**
 * Back `ListDocumentsRequestDto`'s `title`/`sourceKind` sort fields (`documents.controller.ts`'s
 * `GET /documents`) the same way `documents_tenantId_createdAt` backs its default — every real
 * query is tenant-scoped first, so `tenantId` leads each.
 */
DocumentSchema.index({ tenantId: 1, title: 1 }, { name: 'documents_tenantId_title' });
DocumentSchema.index({ tenantId: 1, sourceKind: 1 }, { name: 'documents_tenantId_sourceKind' });
