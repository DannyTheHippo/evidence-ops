import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../constants/tenant.constant';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type DocumentVersionDocument = HydratedDocument<WithTimestamps<DocumentVersion>>;

@Schema({ timestamps: true, collection: 'document_versions' })
export class DocumentVersion extends AuditableDocument {
  @Prop({ type: Types.ObjectId, ref: 'Document', required: true })
  documentId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 1 })
  versionNumber: number;

  // What a citation pins: a re-upload of changed bytes is a new version with a new sha256, so an
  // existing citation stays honest about exactly which bytes it referred to, even after the
  // document's current version moves on. Indexed uniquely per document — see the migration that
  // owns this schema's indexes, not a `@Prop({ index: true })` (`rules/mongoose.md`).
  @Prop({ type: String, required: true, minlength: 64, maxlength: 64, lowercase: true })
  sha256: string;

  @Prop({ type: Number, required: true, min: 0 })
  sizeBytes: number;

  @Prop({ type: String, required: true })
  storageKey: string;

  @Prop({ type: String, required: true, default: DEFAULT_TENANT_ID })
  tenantId: string;
}

export const DocumentVersionSchema = SchemaFactory.createForClass(DocumentVersion);
