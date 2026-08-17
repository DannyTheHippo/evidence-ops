import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type DocumentVersionDocument = HydratedDocument<WithTimestamps<DocumentVersion>>;

export type DocumentVersionIngestionStatus = 'pending' | 'completed' | 'failed';

export const DOCUMENT_VERSION_INGESTION_STATUSES: readonly DocumentVersionIngestionStatus[] = [
  'pending',
  'completed',
  'failed',
];

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

  // Explicit completion marker (closes a tracked defect in `IngestionService.ingestVersion`): a
  // chunk count alone can't distinguish "never ingested" from "crashed between the chunk insert
  // and the rollback", because both leave zero-or-partial chunks. `ingestVersion` now reads this
  // field instead of inferring completion from chunk presence, and treats anything short of
  // `completed` as needing a clean re-ingest.
  @Prop({
    type: String,
    required: true,
    enum: DOCUMENT_VERSION_INGESTION_STATUSES,
    default: 'pending',
  })
  ingestionStatus: DocumentVersionIngestionStatus;

  // Compare-and-set lease for `IngestionService.ingestVersion`'s concurrent-attempt guard: set
  // (overwriting any prior value) when an attempt claims the version, cleared on that same
  // attempt's successful completion. A later attempt's claim always wins the field, so an
  // earlier, still-running attempt can detect at completion time that it has been superseded and
  // must not touch chunks a newer attempt owns. Optional and never read on a version this field
  // predates, so no backfill migration is needed.
  @Prop({ type: Types.ObjectId })
  ingestionLeaseToken?: Types.ObjectId;

  /**
   * Populated only when `ingestionStatus` is `'failed'` — the parser exception message, verbatim,
   * from the attempt that set that status (`IngestionService.ingestVersion`). Optional and
   * unindexed: a version predating this field has no failure to record and there is no query
   * pattern over this field, so no migration accompanies its addition (`.claude/rules/mongoose.md`
   * requires one only for an index or a backfill).
   */
  @Prop({ type: String })
  ingestionFailureReason?: string;

  @Prop({ type: String, required: true })
  tenantId: string;
}

export const DocumentVersionSchema = SchemaFactory.createForClass(DocumentVersion);
