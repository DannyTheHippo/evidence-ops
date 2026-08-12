import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../constants/tenant.constant';
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

  @Prop({ type: String, required: true, default: DEFAULT_TENANT_ID })
  tenantId: string;
}

export const DocumentSchema = SchemaFactory.createForClass(Document);
