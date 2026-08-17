import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type DocumentSourceKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'tsv' | 'txt' | 'md';

export const DOCUMENT_SOURCE_KINDS: readonly DocumentSourceKind[] = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'tsv',
  'txt',
  'md',
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

export type DocumentDocument = HydratedDocument<WithTimestamps<Document>>;

@Schema({ timestamps: true, collection: 'documents' })
export class Document extends AuditableDocument {
  @Prop({ type: String, required: true, trim: true })
  title: string;

  // Routes which extractor pipeline parses this document; correlates 1:1 with the
  // `EvidenceLocator` kind prefix (pdf-page/docx-paragraph/xlsx-*), so a chunk's locator variant
  // is always predictable from its document's sourceKind. Distinct from `mimeType`, which is the
  // raw content type as uploaded.
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
}

export const DocumentSchema = SchemaFactory.createForClass(Document);
