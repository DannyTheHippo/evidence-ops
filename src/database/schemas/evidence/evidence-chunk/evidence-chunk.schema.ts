import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types, WithTimestamps } from 'mongoose';
import type { ChunkElement } from '../../../../features/evidence/ingestion/chunk.type';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { EvidenceLocator } from './evidence-locator.type';

export type EvidenceChunkDocument = HydratedDocument<WithTimestamps<EvidenceChunk>>;

@Schema({ timestamps: true, collection: 'evidence_chunks' })
export class EvidenceChunk extends AuditableDocument<string> {
  // Content-addressed, not auto-generated: `computeChunkId`
  // (`../../../../features/evidence/ingestion/compute-chunk-id.ts`) derives this from the owning
  // tenant, the owning `DocumentVersion.sha256`, the chunk's ordinal, and its locator, so
  // re-ingesting identical bytes for the same tenant reproduces the identical id — see that
  // function's doc comment for why this is the fix for the eval replay cache's per-run `chunkId`
  // drift (ADR-0007), and for why `tenantId` is folded in (a cross-tenant id collision, caught by
  // the live integration suite). Overriding the inherited
  // `_id` type to `String` disables Mongoose's default ObjectId auto-generation, so `required:
  // true` fails CLOSED on a document written without one — every writer
  // (`IngestionService.ingestVersion`) always computes and assigns one explicitly, so a chunk
  // reaching Mongo with no `_id` is a construction bug, not a normal path, and letting Mongo mint
  // a fallback would silently produce an id no future ingest run could ever reproduce.
  //
  // `declare` rather than a plain redeclaration: this narrows the inherited `_id`'s *type* for
  // TypeScript without emitting a field initializer that would shadow what Mongoose hydrates onto
  // the document at runtime (TS2612). The `@Prop` decorator still registers the String `_id` on the
  // schema — only the emitted class field is suppressed.
  @Prop({ type: String, required: true })
  declare _id: string;

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

  // The constituent elements this chunk was built from, each with its own locator and text —
  // `[]` for a spreadsheet preamble chunk, whose own `locator` is already an exact range; a
  // spreadsheet row-window chunk carries a header element and a data element instead, each named
  // more precisely than the chunk's own `locator`. What lets `resolveCitationLocator` (`chunker.ts`)
  // resolve a citation's quote to the specific element it actually came from, rather than only
  // `locator`'s anchor (the chunk's *first* spanned element). `default: []`, not `required`, mirrors
  // `Answer.claims`'s pattern for the same reason: a Mongoose default never populates a `.lean()`
  // read, so a row written before this field existed returns `undefined` here, not `[]` — every
  // reader must tolerate that, not only an empty array.
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  elements: ChunkElement[];

  @Prop({ type: String, required: true })
  tenantId: string;

  // Tags which `IngestionService.ingestVersion` attempt wrote this row. Required because a
  // deterministic `_id` means two concurrent attempts over the *same* version's bytes compute the
  // *same* chunk ids — a losing attempt's post-failure rollback must be scoped to `{
  // documentVersionId, ingestionAttemptToken }`, never to `_id`, or it would delete the winning
  // attempt's rows out from under it. See `IngestionService.ingestVersion`'s doc comment for the
  // race this closes.
  @Prop({ type: Types.ObjectId, required: true })
  ingestionAttemptToken: Types.ObjectId;
}

export const EvidenceChunkSchema = SchemaFactory.createForClass(EvidenceChunk);
