import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { DOCUMENT_SOURCE_CLASSES, type DocumentSourceClass } from '../document/document.schema';

export type SourceKind = 'local-folder';

export const SOURCE_KINDS: readonly SourceKind[] = ['local-folder'];

/**
 * How this source's bytes get into the corpus: `'connector'` syncs automatically through `kind`;
 * `'export-only'` has no connector and relies on someone periodically handing over an export;
 * `'manual'` is catalogued with no ingestion path at all yet. Independent of `tracked` below — a
 * `'connector'` source can still be `tracked: false` if it is catalogued without being synced.
 */
export type SourceConnectivity = 'connector' | 'export-only' | 'manual';

export const SOURCE_CONNECTIVITIES: readonly SourceConnectivity[] = [
  'connector',
  'export-only',
  'manual',
];

/**
 * Whether the estate's own access posture would let this system reach this source at all, distinct
 * from `connectivity` (which only says how bytes would move if it were reachable). `'prohibited'`
 * records standing client policy, not an incident.
 */
export type SourceReachability = 'live' | 'possible' | 'prohibited';

export const SOURCE_REACHABILITIES: readonly SourceReachability[] = [
  'live',
  'possible',
  'prohibited',
];

export type SourceDocument = HydratedDocument<WithTimestamps<Source>>;

/**
 * Per-file sync state for one entry under a `Source`'s `path`. `sizeBytes` and `mtimeMs` are a
 * cheap change watermark a sync pass can check without reading the file; `sha256` is the
 * correctness backstop for when that watermark lies (a touch that leaves bytes unchanged, or a
 * filesystem with coarse mtime resolution). `documentId` links the file to the `Document` its
 * bytes were ingested as, so a later sync pass can diff against the version already on record
 * instead of re-deriving that link from scratch.
 *
 * `documentId` and `sha256` are both absent on a placeholder entry: a file `SourcesService`
 * discovered but never turned into a `Document` at all — an unresolvable kind, an oversized file,
 * or a fetch failure on a file with no prior entry. Such a file has nothing a `documentId` could
 * reference and, for the unresolvable-kind and oversized cases, no bytes were ever read to hash.
 * `lastError` is always set on a placeholder, which is what `SourcesService.syncOneFile` and
 * `.toResultWithFileStates` key off instead of a separate status field.
 *
 * `absentSweeps` and `withdrawnAt` track `SourcesService.runSync`'s two-strike absence guard: a
 * path missing from one sweep's fresh listing increments `absentSweeps` rather than withdrawing
 * immediately, and only a second consecutive absent sweep sets `withdrawnAt`. Both stay populated
 * on a withdrawn entry — every other field keeps its last-known value (`sha256`/`sizeBytes`/
 * `mtimeMs`/`documentId`) so the tombstone still records what the file was before it vanished. A
 * placeholder entry's `withdrawnAt` never sets `documentId`.
 */
export interface SourceFileState {
  path: string;
  sha256?: string;
  sizeBytes: number;
  mtimeMs: number;
  documentId?: Types.ObjectId;
  lastError?: string;
  absentSweeps?: number;
  withdrawnAt?: Date;
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
    // Absent on a placeholder entry — see SourceFileState's own doc comment.
    sha256: { type: String, minlength: 64, maxlength: 64, lowercase: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    mtimeMs: { type: Number, required: true, min: 0 },
    documentId: { type: Types.ObjectId, ref: 'Document' },
    lastError: { type: String },
    absentSweeps: { type: Number, min: 0 },
    withdrawnAt: { type: Date },
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

  @Prop({ type: String, required: true })
  tenantId: string;

  @Prop({ type: String, required: true, enum: SOURCE_CONNECTIVITIES, default: 'connector' })
  connectivity: SourceConnectivity;

  @Prop({ type: String, required: true, enum: SOURCE_REACHABILITIES, default: 'live' })
  reachability: SourceReachability;

  /**
   * The person or team accountable for this source, entered during the estate's inventory pass.
   * Deliberately never defaulted or backfilled: its absence is the gap the inventory exists to
   * surface, and inventing a value here would erase that signal.
   */
  @Prop({ type: String, trim: true })
  owner?: string;

  /**
   * `false` marks an inventory-only row: catalogued for the estate map but never handed to the
   * sync loop. `SourcesService.runSync` fails CLOSED on this — it exits the recurring loop before
   * ever listing files for a source with `tracked: false`, no matter how the loop was started.
   */
  @Prop({ type: Boolean, required: true, default: true })
  tracked: boolean;

  /**
   * Default `Document.sourceClass` a document created from this source's sync pass inherits — see
   * that field's own doc comment for what `'unclassified'` means. A per-file override at upload
   * time is a later step; this is the source-level default every connector-ingested document
   * starts from.
   */
  @Prop({
    type: String,
    required: true,
    enum: DOCUMENT_SOURCE_CLASSES,
    default: 'unclassified',
  })
  sourceClass: DocumentSourceClass;

  /**
   * `sourceClass` as of the moment before the last change that actually altered it —
   * `SourcesService.update` stamps this only when the new value differs from the old one, so an
   * update that leaves `sourceClass` untouched (or re-sets it to the same value) never touches
   * this field either. Absent means `sourceClass` has never changed since creation, which is also
   * what a document-class-drift report reads as "nothing to reconcile": documents ingested under
   * this source have never had a superseded class to drift from. No index and no backfill — this
   * field only ever describes drift that occurs after it exists, never drift a pre-existing source
   * already carries silently.
   */
  @Prop({ type: String, enum: DOCUMENT_SOURCE_CLASSES })
  previousSourceClass?: DocumentSourceClass;

  /**
   * When `runSync`'s absence guards (G1 empty listing, G2 proportional circuit breaker) most
   * recently suppressed a withdrawal that would otherwise have fired — visible evidence that a
   * sync which reported `lastSyncStatus: 'ok'` still had something worth an operator's attention,
   * since neither guard is itself a sync failure. Deliberately NOT folded into `lastSyncStatus`:
   * `SourcesService.list` filters on that field, and a third value would read every such source as
   * not-ok to every existing consumer, which is false — the file sync itself succeeded.
   */
  @Prop({ type: Date })
  lastWithdrawalSuppressedAt?: Date;

  /** Populated only alongside `lastWithdrawalSuppressedAt` — a short stable token, not prose; see
   *  the guard constants in `sources.service.ts` for what each one means. */
  @Prop({ type: String })
  lastWithdrawalSuppressedReason?: string;
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
