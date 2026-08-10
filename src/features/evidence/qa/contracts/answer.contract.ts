import { z } from 'zod';

// `rules/typescript-general.md` / project convention reserves zod for env parsing
// (`environment.config.ts`); HTTP request/response DTOs use class-validator/class-transformer
// instead. This file is the deliberate exception: `answerContractSchema` is converted to a JSON
// Schema to constrain the model's structured output, and the same schema is meant to be reused by
// the eval dataset in `eval/` once a runner exists to score responses against it — a single
// runtime-validatable source of truth matters more here than consistency with the DTO convention.

/**
 * Mirrors `EvidenceLocator` in
 * `src/database/schemas/evidence/evidence-chunk/evidence-locator.type.ts` structurally, not by
 * import — database schemas do not depend on feature contracts. Kept in sync by a compile-time
 * assignability check in `answer.contract.spec.ts`.
 */
const pdfPageLocatorSchema = z.object({
  kind: z.literal('pdf-page'),
  extractorVersion: z.string().min(1),
  page: z.number().int().positive(),
  boundingBox: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional(),
});

const docxParagraphLocatorSchema = z.object({
  kind: z.literal('docx-paragraph'),
  extractorVersion: z.string().min(1),
  paragraphIndex: z.number().int().nonnegative(),
  headingPath: z.array(z.string()),
});

const xlsxRegionLocatorSchema = z.object({
  kind: z.literal('xlsx-region'),
  extractorVersion: z.string().min(1),
  sheetName: z.string().min(1),
  range: z.string().min(1), // A1 range, e.g. "A1:C10"
});

const xlsxCellLocatorSchema = z.object({
  kind: z.literal('xlsx-cell'),
  extractorVersion: z.string().min(1),
  sheetName: z.string().min(1),
  cell: z.string().min(1), // A1 cell, e.g. "B7"
});

export const locatorSchema = z.discriminatedUnion('kind', [
  pdfPageLocatorSchema,
  docxParagraphLocatorSchema,
  xlsxRegionLocatorSchema,
  xlsxCellLocatorSchema,
]);

export type Locator = z.infer<typeof locatorSchema>;

/** A citation pins the exact bytes a claim rests on: which version, which content hash, which
 * chunk, where inside it, and a verbatim (not paraphrased) quote capped at 300 characters so a
 * citation can be spot-checked against the source without re-reading the whole chunk. */
export const citationSchema = z.object({
  docVersionId: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, 'sha256 must be a 64-character hex digest'),
  chunkId: z.string().min(1),
  locator: locatorSchema,
  quote: z.string().min(1).max(300),
});

export type Citation = z.infer<typeof citationSchema>;

export const claimSchema = z.object({
  statement: z.string().min(1),
  citations: z.array(citationSchema).min(1),
});

export type Claim = z.infer<typeof claimSchema>;

// Exported (unlike the other two outcome branches below) because the grounding gate
// (`../grounding-gate.service.ts`) only ever verifies the `answered` branch — `insufficient_evidence`
// and `conflicting_evidence` have no claims to check — and needs a name for that narrowed input
// rather than accepting the full `AnswerContract` union and re-deriving it.
export const answeredOutcomeSchema = z.object({
  kind: z.literal('answered'),
  claims: z.array(claimSchema).min(1),
});

export type AnsweredOutcome = z.infer<typeof answeredOutcomeSchema>;

// `insufficient_evidence` is a valid success state, not an error — the (not yet built) eval
// harness is meant to reward producing it on genuinely unanswerable questions rather than
// fabricating a claim.
const insufficientEvidenceOutcomeSchema = z.object({
  kind: z.literal('insufficient_evidence'),
  reason: z.string().min(1),
});

const conflictingValueSchema = z.object({
  value: z.number(),
  unit: z.string().min(1),
  sourceChunkId: z.string().min(1),
});

const conflictingEvidenceOutcomeSchema = z.object({
  kind: z.literal('conflicting_evidence'),
  factKey: z.object({
    entity: z.string().min(1),
    metric: z.string().min(1),
    period: z.string().min(1),
  }),
  values: z.array(conflictingValueSchema).min(2),
});

/**
 * The model-authored part of an answer. This is the only schema converted to a JSON Schema for
 * the structured-output constraint, so the model can never be asked to (and never legitimately
 * can) produce `claimCoverage`, a verification report, or a dropped-claim record — those exist
 * only in `AnswerEnvelope` below, which the model never sees.
 */
export const answerContractSchema = z.discriminatedUnion('kind', [
  answeredOutcomeSchema,
  insufficientEvidenceOutcomeSchema,
  conflictingEvidenceOutcomeSchema,
]);

export type AnswerContract = z.infer<typeof answerContractSchema>;

export const droppedClaimSchema = z.object({
  statement: z.string().min(1),
  reason: z.string().min(1),
});

export type DroppedClaim = z.infer<typeof droppedClaimSchema>;

/** Computed after the model call by checking each claim's citation against the actual chunk
 * bytes (quote match, locator validity). Never accept these fields from the model. */
export const verificationReportSchema = z.object({
  verifiedClaimCount: z.number().int().nonnegative(),
  totalClaimCount: z.number().int().nonnegative(),
  droppedClaims: z.array(droppedClaimSchema),
});

export type VerificationReport = z.infer<typeof verificationReportSchema>;

/**
 * Envelope wrapping the model-authored `outcome` with server-computed enrichment. Structurally,
 * a value conforming to `AnswerEnvelope` cannot be produced by parsing the model's structured
 * output alone (`answerContractSchema` has no `claimCoverage`/`verificationReport` fields to
 * copy forward) — the server must compute and attach them itself.
 *
 * The persisted `Answer` Mongoose schema (`src/database/schemas/evidence/answer/answer.schema.ts`)
 * stores this envelope's fields flattened directly onto the document (`outcome`, `claimCoverage`,
 * `verificationReport` as siblings) rather than nested under an `envelope` key, so they can be
 * queried/indexed independently; this type is what the qa service constructs before persisting.
 */
export const answerEnvelopeSchema = z.object({
  outcome: answerContractSchema,
  claimCoverage: z.number().min(0).max(1),
  verificationReport: verificationReportSchema,
});

export type AnswerEnvelope = z.infer<typeof answerEnvelopeSchema>;
