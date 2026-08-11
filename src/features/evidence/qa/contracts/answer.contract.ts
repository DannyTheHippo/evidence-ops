import { z } from 'zod';

// `rules/typescript-general.md` / project convention reserves zod for env parsing
// (`environment.config.ts`); HTTP request/response DTOs use class-validator/class-transformer
// instead. This file is the deliberate exception: `answerContractSchema` is converted to a JSON
// Schema to constrain the model's structured output, and the same schema is reused by the eval
// runner (`eval/run.ts`) to score responses — a single runtime-validatable source of truth matters
// more here than consistency with the DTO convention.

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
 * citation can be spot-checked against the source without re-reading the whole chunk.
 *
 * This is the server-resolved shape, not what the model produces — see `modelCitationSchema`
 * below for what the model is actually shown and asked to cite, and `SynthesisService.
 * synthesizeAnswer` (`../synthesis.service.ts`) for where `docVersionId`/`sha256`/`locator` get
 * filled in from the retrieved chunk a citation's `chunkId` names. */
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

/**
 * What the model is actually shown for a chunk — `chunkId` and a human-readable `locator` display
 * string such as "PDF page 3" (`formatLocator` in `../prompts/format-locator.ts`) — and therefore
 * all it can honestly cite by. `docVersionId`, `sha256`, and the *structured* `locator` object
 * `citationSchema` above requires (in particular `extractorVersion`, which appears in no form
 * anywhere in the prompt) are never shown to the model at all. Requiring any of the three from the
 * model asked for a value the prompt structurally cannot supply — the model invented one every
 * time (the incident this schema split fixes: every `sha256` in a real response failed
 * `ModelSchemaValidationError` after one retry with "sha256 must be a 64-character hex digest",
 * because the model was fabricating a string, not reporting a real hash). All three are
 * server-known facts about a retrieved chunk, not judgements the model is making, so they are
 * resolved server-side by `chunkId` lookup instead — see `SynthesisService.synthesizeAnswer`'s
 * `resolveCitation`.
 */
export const modelCitationSchema = z.object({
  chunkId: z.string().min(1),
  quote: z.string().min(1).max(300),
});

export type ModelCitation = z.infer<typeof modelCitationSchema>;

export const modelClaimSchema = z.object({
  statement: z.string().min(1),
  citations: z.array(modelCitationSchema).min(1),
});

export type ModelClaim = z.infer<typeof modelClaimSchema>;

// Exported (unlike the other two outcome branches below) because the grounding gate
// (`../grounding-gate.service.ts`) only ever verifies the `answered` branch — `insufficient_evidence`
// and `conflicting_evidence` have no claims to check — and needs a name for that narrowed input
// rather than accepting the full `AnswerContract` union and re-deriving it.
export const answeredOutcomeSchema = z.object({
  kind: z.literal('answered'),
  claims: z.array(claimSchema).min(1),
});

export type AnsweredOutcome = z.infer<typeof answeredOutcomeSchema>;

/** Same narrowing rationale as `answeredOutcomeSchema` above, for the schema actually sent to the
 * model — see `modelAnswerContractSchema`. */
export const modelAnsweredOutcomeSchema = z.object({
  kind: z.literal('answered'),
  claims: z.array(modelClaimSchema).min(1),
});

export type ModelAnsweredOutcome = z.infer<typeof modelAnsweredOutcomeSchema>;

// `insufficient_evidence` is a valid success state, not an error — the eval harness scores it as
// correct (abstention accuracy) on genuinely unanswerable questions, so producing it beats
// fabricating a claim.

/**
 * Closed set of reasons the model may select for `insufficient_evidence` — this, not a free-text
 * `reason`, is what the model's structured output actually carries (see
 * `modelInsufficientEvidenceOutcomeSchema`). `SynthesisService.renderInsufficientEvidenceReason`
 * maps each code to a fixed, server-authored sentence. A closed enum cannot smuggle a
 * prompt-injection marker the way a free-text field can — there is no sanitiser to outrun because
 * there is nothing left to sanitise.
 */
export const insufficientEvidenceReasonCodeSchema = z.enum([
  'no_relevant_evidence',
  'evidence_does_not_address_question',
  'retrieved_evidence_contradicts_itself',
]);

export type InsufficientEvidenceReasonCode = z.infer<typeof insufficientEvidenceReasonCodeSchema>;

// This is the SERVER-RESOLVED shape — `reason` is rendered by `SynthesisService`'s
// `renderInsufficientEvidenceReason` from a model-selected `reasonCode`
// (`modelInsufficientEvidenceOutcomeSchema` below), never accepted as free text from the model
// (ADR-0004 bound 4, closed). Exported because `answerEnvelopeSchema`/`Answer.outcome` reuse it
// as-is for persistence.
//
// `reasonCode` is optional and, when present, is always one of the three closed literals above —
// safe to carry forward from the model's own selection because bound 4 already constrained it to
// a non-free-text enum (nothing left to sanitise). It is absent whenever this outcome was not an
// honest model-authored abstention: a legacy persisted `Answer` recorded before this field
// existed, or the grounding gate's own degraded `insufficient_evidence` (`activities.ts`'s
// `groundingCheck`, built when every claim is dropped) never had a model-selected code to begin
// with — fabricating one there would misrepresent the gate's decision as the model's own.
// `src/worker/activities.ts`'s `groundingCheck` reads this field as a HINT toward
// `conflicting_evidence`, never as the verdict — see that file's own doc comment for the
// independent, server-side verification the hint still has to pass before it changes anything.
export const insufficientEvidenceOutcomeSchema = z.object({
  kind: z.literal('insufficient_evidence'),
  reason: z.string().min(1),
  reasonCode: insufficientEvidenceReasonCodeSchema.optional(),
});

/** The model-facing counterpart of `insufficientEvidenceOutcomeSchema` above — see that schema's
 * doc comment and `insufficientEvidenceReasonCodeSchema`'s for why a code, not a rendered
 * sentence, is what the model is asked to produce. */
export const modelInsufficientEvidenceOutcomeSchema = z.object({
  kind: z.literal('insufficient_evidence'),
  reasonCode: insufficientEvidenceReasonCodeSchema,
});

export type ModelInsufficientEvidenceOutcome = z.infer<
  typeof modelInsufficientEvidenceOutcomeSchema
>;

const conflictingValueSchema = z.object({
  value: z.number(),
  unit: z.string().min(1),
  sourceChunkId: z.string().min(1),
});

/**
 * The `conflicting_evidence` outcome, server-resolved shape. Deliberately absent from
 * `modelAnswerContractSchema` below (ADR-0004 bound 4, closed) — the model is never offered this
 * branch at all, so `factKey`'s free-text labels and `values[].unit`/`sourceChunkId` can never
 * reach a caller as model-authored text with no check. The only producer is
 * `src/worker/activities.ts`'s `groundingCheck`, which builds this outcome server-side from a
 * real `ConflictedFactGroup` when the grounding gate forces a conflict — never from a model's own
 * say-so. A model that itself notices conflicting evidence has no way to report it except
 * `insufficient_evidence` with `reasonCode: 'retrieved_evidence_contradicts_itself'`; verifying an
 * arbitrary model-authored `factKey`/`values` was considered and rejected — see this schema's own
 * ADR-0004 bound 4 write-up for why containment-checking free text against the retrieved chunks
 * does not close this channel (the canary text is, genuinely, present in a retrieved chunk).
 */
export const conflictingEvidenceOutcomeSchema = z.object({
  kind: z.literal('conflicting_evidence'),
  factKey: z.object({
    entity: z.string().min(1),
    metric: z.string().min(1),
    period: z.string().min(1),
  }),
  values: z.array(conflictingValueSchema).min(2),
});

/**
 * What is actually sent to Anthropic as the structured-output JSON Schema constraint (see
 * `SynthesisService.synthesizeAnswer`, `toStructuredOutputFormat`). Its `answered` branch uses
 * `modelAnsweredOutcomeSchema` (citations are `chunkId` + `quote` only — see
 * `modelCitationSchema`'s doc comment for why); `insufficient_evidence` uses
 * `modelInsufficientEvidenceOutcomeSchema` (`reasonCode`, not free text — see that schema's doc
 * comment). `conflicting_evidence` is not offered to the model at all (see
 * `conflictingEvidenceOutcomeSchema`'s doc comment) — the two branches this union does **not**
 * carry are exactly the two channels ADR-0004 bound 4 named as reaching a caller unverified. The
 * model can never be asked to (and never legitimately can) produce `claimCoverage`, a
 * verification report, or a dropped-claim record either way — those exist only in
 * `AnswerEnvelope` further below, which the model never sees.
 */
export const modelAnswerContractSchema = z.discriminatedUnion('kind', [
  modelAnsweredOutcomeSchema,
  modelInsufficientEvidenceOutcomeSchema,
]);

export type ModelAnswerContract = z.infer<typeof modelAnswerContractSchema>;

/**
 * The server-resolved counterpart of `modelAnswerContractSchema`: its `answered` branch's
 * citations also carry `docVersionId`/`sha256`/`locator`, filled in by
 * `SynthesisService.synthesizeAnswer` from the retrieved chunk each citation's `chunkId` names;
 * its `insufficient_evidence` branch carries a server-rendered `reason` sentence, not the model's
 * `reasonCode`; its `conflicting_evidence` branch is never produced from a model-facing schema at
 * all (see `conflictingEvidenceOutcomeSchema`'s doc comment). This is what `GroundingGateService`
 * verifies, what `Answer.outcome` persists, and what `eval/run.ts` scores against — never what
 * the model produces directly.
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
