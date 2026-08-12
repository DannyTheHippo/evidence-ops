import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types, WithTimestamps } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../constants/tenant.constant';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type SourceKind = 'local-folder';

export const SOURCE_KINDS: readonly SourceKind[] = ['local-folder'];

export type SourceDocument = HydratedDocument<WithTimestamps<Source>>;

/**
 * Per-file sync state for one entry under a `Source`'s `path`. `sizeBytes` and `mtimeMs` are a
 * cheap change watermark a sync pass can check without reading the file; `sha256` is the
 * correctness backstop for when that watermark lies (a touch that leaves bytes unchanged, or a
 * filesystem with coarse mtime resolution). `documentId` links the file to the `Document` its
 * bytes were ingested as, so a later sync pass can diff against the version already on record
 * instead of re-deriving that link from scratch.
 */
export interface SourceFileState {
  path: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  documentId: Types.ObjectId;
  lastError?: string;
}

/**
 * Value object, not an entity, for the same reasoning `FactKeySchema` documents on
 * `ExtractedFact`: a `Source`'s file-state list is only ever read and replaced as a whole by the
 * sync pass that owns it, so it has no identity of its own. `_id: false` keeps Mongoose from
 * minting a meaningless ObjectId inside every entry.
 */
const SourceFileStateSchema = new MongooseSchema<SourceFileState>(
  {
    path: { type: String, required: true },
    sha256: { type: String, required: true, minlength: 64, maxlength: 64, lowercase: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    mtimeMs: { type: Number, required: true, min: 0 },
    documentId: { type: Types.ObjectId, ref: 'Document', required: true },
    lastError: { type: String },
  },
  { _id: false },
);

/**
 * A configured location a sync connector reads documents from. `kind` selects which connector
 * applies; `path`, `enabled`, and `intervalMs` are that connector's configuration, and
 * `fileStates` is the per-file watermark the connector's sync pass compares against on each run
 * to decide what changed. The connector, the sync service, and the workflow that drives a sync
 * attempt are not part of this schema.
 */
@Schema({ timestamps: true, collection: 'sources' })
export class Source extends AuditableDocument {
  @Prop({ type: String, required: true, trim: true })
  name: string;

  /**
   * Selects which connector syncs this source. Modelled as an extensible string union, mirroring
   * `DocumentSourceKind` on `Document`, so a future connector kind joins by widening this union
   * and `SOURCE_KINDS` rather than by changing the schema shape.
   */
  @Prop({ type: String, required: true, enum: SOURCE_KINDS })
  kind: SourceKind;

  @Prop({ type: String, required: true })
  path: string;

  @Prop({ type: Boolean, required: true, default: true })
  enabled: boolean;

  /** Per-source override of `config.sources.syncIntervalMs`; absent means the global default applies. */
  @Prop({ type: Number })
  intervalMs?: number;

  @Prop({ type: String })
  syncWorkflowId?: string;

  /**
   * Compare-and-set lease for the sync service's concurrent-attempt guard, the same role
   * `DocumentVersion.ingestionLeaseToken` plays for `IngestionService.ingestVersion`: set
   * (overwriting any prior value) when an attempt claims this source, cleared on that same
   * attempt's successful completion.
   */
  @Prop({ type: Types.ObjectId })
  syncLeaseToken?: Types.ObjectId;

  @Prop({ type: Date })
  lastSyncAt?: Date;

  /**
   * Outcome of the most recent sync attempt. Left as an open string rather than an enum here —
   * the sync service that owns this vocabulary is a later step, not part of this schema change.
   */
  @Prop({ type: String })
  lastSyncStatus?: string;

  /** Populated only when `lastSyncStatus` names a failed attempt, mirroring
   * `DocumentVersion.ingestionFailureReason`. */
  @Prop({ type: String })
  lastSyncError?: string;

  @Prop({ type: [SourceFileStateSchema], default: [] })
  fileStates: SourceFileState[];

  @Prop({ type: String, required: true, default: DEFAULT_TENANT_ID })
  tenantId: string;
}

export const SourceSchema = SchemaFactory.createForClass(Source);

/**
 * Declared here as well as in `migrations/0014-sources-indexes.ts`, with the same keys, options and
 * names. The migration is what builds them in a deployed database; these declarations are what
 * `Model.syncIndexes()` builds, which is how a test lane that never runs migrations still enforces
 * the uniqueness `SourcesService.create` relies on to return a 409.
 */
SourceSchema.index({ tenantId: 1, createdAt: -1 }, { name: 'sources_tenantId_createdAt' });
SourceSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, name: 'sources_tenantId_name_unique' },
);
