import { Inject, Injectable } from '@nestjs/common';
import type { AnswerUsage } from '../../../database/schemas/evidence/answer/answer.schema';
import {
  MODEL_PROVIDER,
  type ModelProvider,
} from '../../../providers/model/model-provider.interface';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import {
  modelAnswerContractSchema,
  type AnswerContract,
  type Citation,
  type InsufficientEvidenceReasonCode,
  type Locator,
  type ModelAnswerContract,
  type ModelCitation,
} from './contracts/answer.contract';
import { assembleAnswerMessages } from './prompts/assemble-answer-messages';
import type { RetrievedChunk } from './types/retrieved-chunk.type';

export interface SynthesizeAnswerInput {
  readonly question: string;
  readonly chunks: readonly RetrievedChunk[];
}

export interface SynthesizeAnswerResult {
  readonly contract: AnswerContract;
  /**
   * Spend for this one synthesis call only — not embedding or fact-extraction spend elsewhere in
   * the pipeline. Threaded through to `Answer.usage` by `answer-question.workflow.ts` /
   * `AnswerPersistenceService`; never read as total QA-request cost.
   */
  readonly usage: AnswerUsage;
}

// A synthesis call carries every retrieved chunk for a question in one user turn (unlike
// `prose-fact-extractor.ts`'s one-chunk-per-call), so both caps sit above that sibling's: more
// input to reason over, and a multi-claim, multi-citation JSON payload to produce. Generous
// rather than tuned tight — a legitimate answer over several chunks should never trip this, so a
// trip here should mean a prompt-construction or pricing-table bug, not normal operation.
const MAX_OUTPUT_TOKENS = 4096;
const MAX_COST_USD = 2;

/**
 * Placeholder locator for a citation whose `chunkId` names a chunk that was never retrieved for
 * this request (see `resolveCitation` below) — there is no real chunk to resolve a locator from.
 * Never read as real provenance: `verifyClaim`'s retrieval-containment check (`../verify-claim.ts`)
 * looks a citation's `chunkId` up against the same retrieved-chunk set *before* reading any other
 * field, and a citation carrying this placeholder always fails that lookup by construction, so
 * nothing downstream ever reaches the placeholder itself.
 */
const UNRESOLVED_LOCATOR: Locator = { kind: 'pdf-page', extractorVersion: 'unresolved', page: 1 };

/**
 * Fills in the server-known facts about a cited chunk — `docVersionId`, `sha256`, `locator` — that
 * `modelCitationSchema` deliberately excludes from what the model is asked to produce (see that
 * schema's doc comment in `./contracts/answer.contract.ts`). Resolution is a `chunkId` lookup
 * against the same `RetrievedChunk[]` the model was shown, so a citation's provenance can never be
 * anything other than what the server itself retrieved for this request.
 *
 * A `chunkId` absent from `chunkById` means the model cited a chunk it fabricated. There is
 * nothing real to resolve, so the citation carries only its (fabricated) `chunkId` and `quote`
 * through, with `UNRESOLVED_LOCATOR` and empty `docVersionId`/`sha256` standing in for the rest.
 * Dropping the citation here instead, rather than passing a resolved-as-far-as-possible one
 * through, would silently swallow the fabrication before `verifyClaim` ever saw it — losing both
 * the specific violation it reports and the fail-closed guarantee that check exists to prove.
 */
function resolveCitation(
  citation: ModelCitation,
  chunkById: ReadonlyMap<string, RetrievedChunk>,
): Citation {
  const retrieved = chunkById.get(citation.chunkId);
  if (!retrieved) {
    return {
      chunkId: citation.chunkId,
      docVersionId: '',
      sha256: '',
      locator: UNRESOLVED_LOCATOR,
      quote: citation.quote,
    };
  }

  return {
    chunkId: retrieved.chunkId,
    docVersionId: retrieved.docVersionId,
    sha256: retrieved.sha256,
    locator: retrieved.locator,
    quote: citation.quote,
  };
}

/**
 * Fixed, server-authored sentences for each `InsufficientEvidenceReasonCode` — the only text that
 * ever reaches a caller as the `insufficient_evidence` outcome's `reason` (see
 * `renderInsufficientEvidenceReason` below and ADR-0004 bound 4).
 */
const INSUFFICIENT_EVIDENCE_REASON_TEXT: ReadonlyMap<InsufficientEvidenceReasonCode, string> =
  new Map([
    ['no_relevant_evidence', 'None of the retrieved evidence is relevant to this question.'],
    [
      'evidence_does_not_address_question',
      'The retrieved evidence does not contain enough information to answer this question.',
    ],
    [
      'retrieved_evidence_contradicts_itself',
      'The retrieved evidence reports conflicting values for the same fact, so no single answer can be given with confidence.',
    ],
  ]);

/** Fail-closed default for a `reasonCode` outside `INSUFFICIENT_EVIDENCE_REASON_TEXT` — see
 * `renderInsufficientEvidenceReason`'s doc comment for when this is actually reachable. */
const GENERIC_INSUFFICIENT_EVIDENCE_REASON =
  'The retrieved evidence does not support an answer to this question.';

/**
 * Renders a model-selected `reasonCode` into the fixed sentence persisted/returned as
 * `AnswerContract`'s `insufficient_evidence.reason` — the model never supplies this text itself
 * (ADR-0004 bound 4, closed). `reasonCode` is typed as one of three literals by
 * `modelInsufficientEvidenceOutcomeSchema`, and a real `AnthropicModelProvider` call enforces that
 * at the structured-output layer (`safeParseJson`), so this lookup should always hit. It still
 * fails CLOSED to a generic sentence for a value outside the map rather than trusting the type,
 * because not every `ModelProvider` in this codebase validates its output —
 * `FakeModelProvider.generate` returns exactly what a test enqueues, unvalidated (see its own doc
 * comment) — and the whole point of this fix is that nothing the model writes ever reaches a
 * caller as free text again, even a value that slipped past validation upstream.
 */
function renderInsufficientEvidenceReason(reasonCode: InsufficientEvidenceReasonCode): string {
  return INSUFFICIENT_EVIDENCE_REASON_TEXT.get(reasonCode) ?? GENERIC_INSUFFICIENT_EVIDENCE_REASON;
}

/**
 * The same fail-closed lookup `renderInsufficientEvidenceReason` uses, reused to decide whether
 * `AnswerContract`'s optional `reasonCode` (see that field's own doc comment in
 * `answer.contract.ts`) is safe to carry forward: a value outside the three known literals never
 * reaches the returned outcome, even from an unvalidated `ModelProvider` (`FakeModelProvider`) —
 * `undefined` here is what keeps `src/worker/activities.ts`'s hint-verify upgrade from ever
 * reading a fabricated code.
 */
function resolveReasonCode(
  reasonCode: InsufficientEvidenceReasonCode,
): InsufficientEvidenceReasonCode | undefined {
  return INSUFFICIENT_EVIDENCE_REASON_TEXT.has(reasonCode) ? reasonCode : undefined;
}

/**
 * Turns the model's `ModelAnswerContract` into the server-resolved `AnswerContract`: resolves
 * every citation in the `answered` branch (`resolveCitation` above), and renders the
 * `insufficient_evidence` branch's fixed sentence from the model's `reasonCode`
 * (`renderInsufficientEvidenceReason` above) rather than passing any model-authored text through.
 *
 * `modelAnswerContractSchema` only ever offers `answered` or `insufficient_evidence` — see that
 * schema's doc comment for why `conflicting_evidence` is not a model-facing branch at all. A real
 * `AnthropicModelProvider` call cannot reach the fallback branch below: `safeParseJson` rejects
 * any other `kind` before this function ever runs. The fallback exists only because
 * `FakeModelProvider` (and, in principle, a future unvalidated `ModelProvider`) can hand this
 * function a shape `ModelAnswerContract` promises will never occur — it fails CLOSED to a generic
 * `insufficient_evidence` rather than forwarding an unverified `factKey`/`values` or throwing on
 * a shape it was never told to expect.
 */
function resolveContract(
  output: ModelAnswerContract,
  chunks: readonly RetrievedChunk[],
): AnswerContract {
  if (output.kind === 'answered') {
    const chunkById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk] as const));

    return {
      kind: 'answered',
      claims: output.claims.map((claim) => ({
        statement: claim.statement,
        citations: claim.citations.map((citation) => resolveCitation(citation, chunkById)),
      })),
    };
  }

  if (output.kind === 'insufficient_evidence') {
    return {
      kind: 'insufficient_evidence',
      reason: renderInsufficientEvidenceReason(output.reasonCode),
      reasonCode: resolveReasonCode(output.reasonCode),
    };
  }

  return {
    kind: 'insufficient_evidence',
    reason: renderInsufficientEvidenceReason('no_relevant_evidence'),
  };
}

/**
 * Turns retrieved evidence into a model-authored `AnswerContract`. Still a generator, not a
 * citation verifier: on the `answered` branch, `resolveContract` only fills in the server-known
 * provenance fields the model was never shown (`docVersionId`, `sha256`, `locator` — see
 * `modelCitationSchema`'s doc comment) by `chunkId` lookup against the same `chunks` this call was
 * given — it adds no claim coverage, no verification report, no dropped-claim record; those are
 * computed by `GroundingGateService` (`./grounding-gate.service.ts`) from this output, and
 * conflating the two would let an unverified model claim reach a caller under the same shape as a
 * gate-checked one. On `insufficient_evidence`, `resolveContract` renders the model's `reasonCode`
 * into a fixed, server-authored sentence rather than passing any model text through (ADR-0004
 * bound 4); on anything else, it fails CLOSED to that same fixed outcome rather than forwarding an
 * unverified payload — see `resolveContract`'s own doc comment for why and when that branch is
 * actually reachable.
 *
 * No retry loop here: `AnthropicModelProvider` already retries once on schema-validation failure,
 * and the Anthropic SDK itself retries transient (network/5xx) failures twice. A third layer would
 * only multiply latency and spend on the same failure classes those two already cover.
 */
@Injectable()
export class SynthesisService {
  constructor(
    @Inject(MODEL_PROVIDER)
    private readonly modelProvider: ModelProvider,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(SynthesisService.name);
  }

  async synthesizeAnswer(input: SynthesizeAnswerInput): Promise<SynthesizeAnswerResult> {
    const { system, messages } = assembleAnswerMessages({
      question: input.question,
      chunks: input.chunks,
    });

    this.logger.debug(
      `Synthesizing answer over ${input.chunks.length} retrieved chunk(s) for question '${input.question}'`,
    );

    const result = await this.modelProvider.generate({
      taskClass: 'qa_answer',
      system,
      messages,
      outputSchema: modelAnswerContractSchema,
      maxTokens: MAX_OUTPUT_TOKENS,
      maxCostUsd: MAX_COST_USD,
    });

    return {
      contract: resolveContract(result.output, input.chunks),
      usage: {
        // Cached tokens are still prompt tokens billed on the call that produced them — omitting
        // `cacheCreationInputTokens`/`cacheReadInputTokens` here would under-report spend on
        // exactly the calls prompt caching makes cheap.
        promptTokens:
          result.usage.inputTokens +
          result.usage.cacheCreationInputTokens +
          result.usage.cacheReadInputTokens,
        completionTokens: result.usage.outputTokens,
        costUsd: result.costUsd,
      },
    };
  }
}
