import { Inject, Injectable } from '@nestjs/common';
import {
  MODEL_PROVIDER,
  type ModelProvider,
} from '../../../providers/model/model-provider.interface';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import {
  modelAnswerContractSchema,
  type AnswerContract,
  type Citation,
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
 * Turns the model's `ModelAnswerContract` into the server-resolved `AnswerContract` by resolving
 * every citation in the `answered` branch (`resolveCitation` above); `insufficient_evidence` and
 * `conflicting_evidence` carry no citations, so they pass through unchanged — the two schemas
 * share those branches verbatim (`answer.contract.ts`).
 */
function resolveContract(
  output: ModelAnswerContract,
  chunks: readonly RetrievedChunk[],
): AnswerContract {
  if (output.kind !== 'answered') {
    return output;
  }

  const chunkById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk] as const));

  return {
    kind: 'answered',
    claims: output.claims.map((claim) => ({
      statement: claim.statement,
      citations: claim.citations.map((citation) => resolveCitation(citation, chunkById)),
    })),
  };
}

/**
 * Turns retrieved evidence into a model-authored `AnswerContract`. Still a generator, not a
 * verifier: `resolveContract` only fills in the server-known provenance fields the model was never
 * shown (`docVersionId`, `sha256`, `locator` — see `modelCitationSchema`'s doc comment) by
 * `chunkId` lookup against the same `chunks` this call was given; it adds no claim coverage, no
 * verification report, no dropped-claim record, and it drops nothing the model didn't already
 * omit. Those are computed by `GroundingGateService` (`./grounding-gate.service.ts`) from this
 * output; conflating the two would let an unverified model claim reach a caller under the same
 * shape as a gate-checked one.
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

  async synthesizeAnswer(input: SynthesizeAnswerInput): Promise<AnswerContract> {
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

    return resolveContract(result.output, input.chunks);
  }
}
