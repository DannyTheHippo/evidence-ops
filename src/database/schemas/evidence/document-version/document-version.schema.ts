import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type DocumentVersionDocument = HydratedDocument<WithTimestamps<DocumentVersion>>;

// 'needs-ocr' is a terminal quarantine state, not a variant of 'failed': it is only ever reached
// from `EmptyPdfTextLayerException` (a scanned PDF with no embedded text layer), a condition that
// is deterministic for the same bytes and never resolves by itself — see
// `IngestionService.recordIngestionFailure` for where it is chosen over 'failed', and
// `ingest-document-version.workflow.ts`'s `nonRetryableErrorTypes` for why the underlying activity
// never retries it either.
// 'facts-failed' is the other partial-success state: the version's chunks are committed and
// searchable, but the fact extraction that follows the ingest never completed, so the version
// carries no `ExtractedFact` rows and no conflict scan has seen it. It is distinct from
// 'completed' because a document the product answers from while knowing nothing in it is not the
// same as one fully ingested, and distinct from 'failed' because the chunks are real and cited
// answers over them are honest — see `IngestionService.recordFactExtractionFailure`, which is the
// only writer, and `ingest-document-version.workflow.ts`, which calls it.
export type DocumentVersionIngestionStatus =
  'pending' | 'completed' | 'facts-failed' | 'failed' | 'needs-ocr';

// Adding a status needs no migration: `enum` on a `@Prop` is a Mongoose-side validator, not a
// database index, so a deployed collection already accepts the new value the moment this file
// ships. The existing query patterns over this field — `document_versions_tenantId_ingestionStatus`
// below, backing `DocumentsService.list`'s filter, and
// `document_versions_ingestionStatus_updatedAt`, backing the reconciler — index the whole field
// regardless of which values it holds, so they cover a new value without a migration too.
export const DOCUMENT_VERSION_INGESTION_STATUSES: readonly DocumentVersionIngestionStatus[] = [
  'pending',
  'completed',
  'facts-failed',
  'failed',
  'needs-ocr',
];

/** Why a version was soft-withdrawn (`withdrawnAt` set). A narrow union rather than a free string
 *  because a withdrawal always has a specific, known cause; `'source-file-absent'` is the only
 *  cause today — `SourcesService.runSync`'s two-strike absence guard. */
export type DocumentVersionWithdrawnReason = 'source-file-absent';

export const DOCUMENT_VERSION_WITHDRAWN_REASONS: readonly DocumentVersionWithdrawnReason[] = [
  'source-file-absent',
];

@Schema({ timestamps: true, collection: 'document_versions' })
export class DocumentVersion extends AuditableDocument {
  @Prop({ type: Types.ObjectId, ref: 'Document', required: true })
  documentId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 1 })
  versionNumber: number;

  // What a citation pins: a re-upload of changed bytes is a new version with a new sha256, so an
  // existing citation stays honest about exactly which bytes it referred to, even after the
  // document's current version moves on. Indexed uniquely per tenant — see the migration that
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
   * Populated when `ingestionStatus` is `'failed'`, `'needs-ocr'` or `'facts-failed'` — the
   * exception message, verbatim, from the attempt that set that status
   * (`IngestionService.ingestVersion` for the first two, `recordFactExtractionFailure` for the
   * third).
   * Optional and unindexed: a version predating this field has no failure to record and there is
   * no query pattern over this field, so no migration accompanies its addition
   * (`.claude/rules/mongoose.md` requires one only for an index or a backfill).
   */
  @Prop({ type: String })
  ingestionFailureReason?: string;

  /**
   * Soft-withdrawal marker: unset for every retrievable version. Set (never unset by `remove`'s
   * hard delete, which removes the row instead) when `SourcesService.runSync` decides the
   * originating source file is gone. Chunks and facts under this version are deliberately
   * retained — a past `Answer` still cites them — only retrieval exclusion (a later step) and
   * `withdrawnReason` read this field.
   */
  @Prop({ type: Date })
  withdrawnAt?: Date;

  /** Populated only alongside `withdrawnAt`, mirroring `ingestionFailureReason`'s pairing with
   *  `ingestionStatus`. */
  @Prop({ type: String, enum: DOCUMENT_VERSION_WITHDRAWN_REASONS })
  withdrawnReason?: DocumentVersionWithdrawnReason;

  @Prop({ type: String, required: true })
  tenantId: string;

  /** Non-empty when this version was ingested with known fidelity loss; each entry states one reason. */
  @Prop({ type: [String], default: [] })
  reducedFidelityReasons: string[];
}

export const DocumentVersionSchema = SchemaFactory.createForClass(DocumentVersion);

/**
 * Declared here as well as in `migrations/0001-baseline.ts`, with the same key
 * pattern, options and name — MongoDB refuses a second index on a key pattern it already carries
 * under a different name, and which side loses depends on boot order. Backs
 * `DocumentsService.list`'s `ingestionStatus` filter: resolving "which versions have this status"
 * for a tenant without a collection scan.
 */
DocumentVersionSchema.index(
  { tenantId: 1, ingestionStatus: 1 },
  { name: 'document_versions_tenantId_ingestionStatus' },
);

/**
 * Declared here as well as in `migrations/0001-baseline.ts`, with the same
 * keys, name and options — same reasoning as the index above. Partial: `withdrawnAt` is absent on
 * the overwhelming majority of versions (every one never withdrawn), so an unfiltered index would
 * carry every row for a predicate that only ever matches a small minority.
 */
DocumentVersionSchema.index(
  { tenantId: 1, withdrawnAt: 1 },
  {
    name: 'document_versions_tenantId_withdrawnAt',
    partialFilterExpression: { withdrawnAt: { $exists: true } },
  },
);

/**
 * Declared here as well as in `migrations/0001-baseline.ts`, with the
 * same keys, name and options — same reasoning as the indexes above. Backs
 * `IngestionService.reconcileStaleAttempts`, which sweeps every tenant at once and so cannot use
 * the `tenantId`-leading index. Partial: only `'pending'` versions are ever swept, which is a
 * small minority of the collection at any moment.
 */
DocumentVersionSchema.index(
  { ingestionStatus: 1, updatedAt: 1 },
  {
    name: 'document_versions_ingestionStatus_updatedAt',
    partialFilterExpression: { ingestionStatus: 'pending' },
  },
);

/**
 * Declared here as well as in `migrations/0001-baseline.ts`, with the same keys, options and
 * name — same reasoning as the indexes above. Backs `DocumentsService.uploadVersion`'s tenant-wide
 * dedupe lookup and closes the race it guards against: within a tenant, one sha256 identifies
 * exactly one `DocumentVersion`, so a concurrent upload of the same bytes loses this index's
 * duplicate-key check rather than minting a second version, and the losing writer's retry takes
 * the dedupe branch instead.
 */
DocumentVersionSchema.index(
  { tenantId: 1, sha256: 1 },
  { name: 'document_versions_tenantId_sha256_unique', unique: true },
);
