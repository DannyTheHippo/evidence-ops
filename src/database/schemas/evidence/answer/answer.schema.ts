import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types, WithTimestamps } from 'mongoose';
import type {
  AnswerContract,
  Claim,
  VerificationReport,
} from '../../../../features/evidence/qa/contracts/answer.contract';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type AnswerRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export const ANSWER_RUN_STATUSES: readonly AnswerRunStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
];

export interface AnswerUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export type AnswerDocument = HydratedDocument<WithTimestamps<Answer>>;

@Schema({ timestamps: true, collection: 'answers' })
export class Answer extends AuditableDocument {
  @Prop({ type: String, required: true })
  questionText: string;

  // Workflow lifecycle. Kept separate from `outcome` (the answer-contract result) because a
  // `failed` run has no outcome, while a `completed` run's outcome can itself report
  // `insufficient_evidence` — conflating the two axes would make "no answer yet" and "answered
  // that there is no answer" indistinguishable.
  @Prop({ type: String, required: true, enum: ANSWER_RUN_STATUSES, default: 'queued' })
  runStatus: AnswerRunStatus;

  // `EvidenceChunk._id` is a content-addressed string (`computeChunkId`), not an ObjectId — see
  // that schema's own doc comment. `ref: 'EvidenceChunk'` still resolves correctly against a
  // String `_id`; Mongoose's `populate` only needs the referenced model name, not an ObjectId type.
  @Prop({ type: [{ type: String, ref: 'EvidenceChunk' }], default: [] })
  retrievedChunkIds: string[];

  // The grounding-gate-verified outcome (see `GroundingCheckActivityResult`'s doc comment in
  // `src/worker/activities.ts`), not necessarily the model's raw output — an `answered` claim
  // with every citation dropped is persisted here as `insufficient_evidence`, never as-is. Set
  // only when `runStatus === 'completed'` — enforced below in `pre('validate')`, not left to
  // convention.
  @Prop({ type: MongooseSchema.Types.Mixed })
  outcome?: AnswerContract;

  // The server-verified surviving claims after checking each citation's quote against the
  // actual chunk bytes — the same set `outcome.claims` carries when `outcome.kind` is
  // `'answered'` (see that field's own doc comment), kept here as its own flat, queryable field
  // because `outcome.claims` doesn't exist on the other two outcome kinds. `verificationReport`
  // explains what was dropped and why.
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  claims: Claim[];

  @Prop({ type: Number, min: 0, max: 1 })
  claimCoverage?: number;

  @Prop({ type: MongooseSchema.Types.Mixed })
  verificationReport?: VerificationReport;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Conflict' }], default: [] })
  conflictIds: Types.ObjectId[];

  @Prop({
    type: {
      promptTokens: { type: Number, required: true },
      completionTokens: { type: Number, required: true },
      costUsd: { type: Number, required: true },
    },
  })
  usage?: AnswerUsage;

  @Prop({ type: String, required: true })
  tenantId: string;
}

export const AnswerSchema = SchemaFactory.createForClass(Answer);

// Data-integrity gate, fails closed: `invalidate` rejects the write rather than silently
// persisting an outcome ahead of the run that was supposed to produce it.
AnswerSchema.pre('validate', function (this: AnswerDocument): void {
  if (this.outcome && this.runStatus !== 'completed') {
    this.invalidate('outcome', 'outcome may only be set when runStatus is completed');
  }
});

// Backs `GET /answers?sort=runStatus|claimCoverage`, the two allowlisted sort fields with no
// existing `{tenantId, ...}` prefix to ride — `answers_tenantId_createdAt` (baseline-only, backing
// the default sort) already covers `createdAt`.
AnswerSchema.index({ tenantId: 1, runStatus: 1 }, { name: 'answers_tenantId_runStatus' });
AnswerSchema.index({ tenantId: 1, claimCoverage: 1 }, { name: 'answers_tenantId_claimCoverage' });
