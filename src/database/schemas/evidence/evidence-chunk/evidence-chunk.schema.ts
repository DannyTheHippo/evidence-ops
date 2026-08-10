import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types, WithTimestamps } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../constants/tenant.constant';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { EvidenceLocator } from './evidence-locator.type';

export type EvidenceChunkDocument = HydratedDocument<WithTimestamps<EvidenceChunk>>;

@Schema({ timestamps: true, collection: 'evidence_chunks' })
export class EvidenceChunk extends AuditableDocument {
  @Prop({ type: Types.ObjectId, ref: 'Document', required: true })
  documentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'DocumentVersion', required: true })
  documentVersionId: Types.ObjectId;

  @Prop({ type: String, required: true })
  text: string;

  @Prop({ type: Number, required: true, min: 0 })
  tokenCount: number;

  // `required` alone is not enough on an array path: Mongoose defaults arrays to `[]`, and an
  // empty array satisfies `required`. A chunk with no vector would save cleanly and then be
  // invisible to `$vectorSearch` — a silent retrieval hole rather than a write error. The
  // length check is what actually closes it. Dimension is enforced by the search index, not here,
  // so the schema does not hard-code a model's output size.
  @Prop({
    type: [Number],
    required: true,
    validate: {
      validator: (value: number[]): boolean => value.length > 0,
      message: 'embedding must contain at least one dimension',
    },
  })
  embedding: number[];

  // Locator shape varies by source kind (pdf/docx/xlsx); a Mongoose subdocument discriminator
  // per variant would buy no query benefit here (the locator is read as a whole, never queried
  // by a specific sub-field), so it is stored as Mixed and shaped by the `EvidenceLocator` TS
  // union at the application boundary.
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  locator: EvidenceLocator;

  @Prop({ type: String, required: true, default: DEFAULT_TENANT_ID })
  tenantId: string;
}

export const EvidenceChunkSchema = SchemaFactory.createForClass(EvidenceChunk);
