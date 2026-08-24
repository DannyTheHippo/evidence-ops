import { z } from 'zod';

import type { GroundingViolationKind } from '../types/grounding-report.type';
import type { Citation } from './answer.contract';

// Same convention exception as `answer.contract.ts`'s header comment: `modelVerifyClaimContractSchema`
// is converted to a JSON Schema to constrain the model's structured output, so a runtime-validatable
// zod schema matters more here than parity with the HTTP DTO convention.

/**
 * The model returns `candidateIndex`, never `chunkId`. `answer.contract.ts`'s `modelCitationSchema`
 * withholds `chunkId`'s server-known siblings for a different reason (the prompt never shows the
 * model a value it could honestly report); here the claim being verified was drafted by another AI
 * assistant and can already carry a fabricated `chunkId`, or one borrowed from unrelated context, in
 * its own reasoning. A `candidateIndex` cannot be fabricated or lifted the same way — it is a
 * bounds-checked integer into the `candidates` array supplied for *this* verification call, so the
 * server can reject an out-of-range value outright rather than trusting an id string against the
 * whole corpus.
 *
 * `quote` carries the same 1-300 character bound `answer.contract.ts` applies to citation quotes.
 */
export const modelVerifyClaimCitationSchema = z
  .object({
    candidateIndex: z.number().int().nonnegative(),
    quote: z.string().min(1).max(300),
  })
  .strict();

export type ModelVerifyClaimCitation = z.infer<typeof modelVerifyClaimCitationSchema>;

/**
 * `supported: false` — the claim is not supported by the candidates shown. No verdict, no reason
 * code, no confidence, no score field: the model is never asked to grade the claim, only to point
 * at (or decline to point at) candidate text.
 */
export const notSupportedOutcomeSchema = z
  .object({
    supported: z.literal(false),
  })
  .strict();

/**
 * `supported: true` — the model is asserting 1 to 3 candidates support the claim. This assent is
 * necessary but never sufficient for a `grounded` verdict: `ClaimVerdict` below is always computed
 * server-side, by a deterministic gate that runs after this schema is parsed and can only ever
 * lower the outcome the model proposed, never raise it.
 */
export const supportedOutcomeSchema = z
  .object({
    supported: z.literal(true),
    citations: z.array(modelVerifyClaimCitationSchema).min(1).max(3),
  })
  .strict();

/**
 * The model's entire output alphabet for one claim-verification call — deliberately this small so
 * it cannot author a verdict. See `notSupportedOutcomeSchema` and `supportedOutcomeSchema` above
 * for what each branch does (and does not) carry.
 */
export const modelVerifyClaimContractSchema = z.discriminatedUnion('supported', [
  notSupportedOutcomeSchema,
  supportedOutcomeSchema,
]);

export type ModelVerifyClaimContract = z.infer<typeof modelVerifyClaimContractSchema>;

/**
 * The server-resolved verdict for one verified claim, closed set: `grounded` — a citation the
 * model pointed at was mechanically verified against the candidate it names; `not_grounded` — the
 * model returned `supported: false`, or every citation it offered failed verification;
 * `no_evidence_retrieved` — no candidates were supplied to check the claim against at all;
 * `conflicting_evidence` — the candidates disagree with each other on the fact the claim rests on.
 */
export type ClaimVerdict =
  'grounded' | 'not_grounded' | 'no_evidence_retrieved' | 'conflicting_evidence';

/**
 * One claim's result within a `VerifyClaimsResult`. `reasonCode` is typed to the same closed
 * `GroundingViolationKind` the answer-synthesis grounding gate already uses (never a free-text
 * string) — this tool degrades a claim for the same mechanical reasons that gate drops one.
 * `citations` carries the server-resolved `Citation` shape (`docVersionId`/`sha256`/`locator`/
 * `quote`), never the model's raw `candidateIndex`-keyed citation.
 */
export interface VerifyClaimResult {
  readonly claimIndex: number;
  readonly verdict: ClaimVerdict;
  readonly reasonCode?: GroundingViolationKind;
  readonly citations?: readonly Citation[];
}

/** The tool's complete result: a fixed `advisory` (see `VERIFY_CLAIMS_ADVISORY` below) plus one
 * `VerifyClaimResult` per submitted claim, in submission order. */
export interface VerifyClaimsResult {
  readonly advisory: string;
  readonly results: readonly VerifyClaimResult[];
}

/**
 * Fixed, never assembled from claim or chunk text — the one sentence every `VerifyClaimsResult`
 * carries regardless of its `results`. States plainly what `grounded` means (an independent
 * verifier located supporting evidence for the claim and mechanically checked the citation and
 * every number the claim states against it) and, just as plainly, what it does not mean: not a
 * claim of truth, and no check here confirms the cited evidence covers the whole statement — only
 * that it overlaps it (`docs/adr/0023-attestation-surface.md` § Known bounds, bound 3).
 */
export const VERIFY_CLAIMS_ADVISORY =
  'A "grounded" verdict means an independent verifier located supporting evidence for this claim ' +
  'and mechanically checked the citation and every number the claim states against it. This is ' +
  'not a claim of truth. It also does not mean the cited evidence covers the whole statement — ' +
  'any part the quotes do not address is not established by this verdict.';
