import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, WithTimestamps } from 'mongoose';
import type { VerifyClaimResult } from '../../../../features/evidence/qa/contracts/verify-claims.contract';
import type { ClaimAtoms } from '../../../../features/evidence/qa/types/claim-atoms.type';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type VerificationRequesterKind = 'pat' | 'user';

export const VERIFICATION_REQUESTER_KINDS: readonly VerificationRequesterKind[] = ['pat', 'user'];

export interface VerificationRequester {
  kind: VerificationRequesterKind;
  id: string;
}

export interface VerificationUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export type VerificationDocument = HydratedDocument<WithTimestamps<Verification>>;

@Schema({ timestamps: true, collection: 'verifications' })
export class Verification extends AuditableDocument {
  @Prop({ type: String, required: true })
  tenantId: string;

  @Prop({
    type: {
      kind: { type: String, required: true, enum: VERIFICATION_REQUESTER_KINDS },
      id: { type: String, required: true },
    },
    required: true,
  })
  requestedBy: VerificationRequester;

  @Prop({ type: [String], required: true })
  claims: string[];

  @Prop({ type: [MongooseSchema.Types.Mixed], required: true })
  results: VerifyClaimResult[];

  @Prop({ type: String, required: true })
  advisory: string;

  // `EvidenceChunk._id` is a content-addressed string (`computeChunkId`), not an ObjectId — see
  // that schema's own doc comment. `ref: 'EvidenceChunk'` still resolves correctly against a
  // String `_id`; Mongoose's `populate` only needs the referenced model name, not an ObjectId type.
  @Prop({ type: [{ type: String, ref: 'EvidenceChunk' }], default: [] })
  retrievedChunkIds: string[];

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  atoms: ClaimAtoms[];

  @Prop({
    type: {
      promptTokens: { type: Number, required: true },
      completionTokens: { type: Number, required: true },
      costUsd: { type: Number, required: true },
    },
    required: true,
  })
  usage: VerificationUsage;
}

export const VerificationSchema = SchemaFactory.createForClass(Verification);

// Backs `GET /verifications`'s tenant-wide newest-first default listing.
VerificationSchema.index(
  { tenantId: 1, createdAt: -1 },
  { name: 'verifications_tenantId_createdAt' },
);
// Backs `GET /verifications?requestedByKind=pat|user`, filtered and still newest-first.
VerificationSchema.index(
  { tenantId: 1, 'requestedBy.kind': 1, createdAt: -1 },
  { name: 'verifications_tenantId_requestedByKind_createdAt' },
);
