import { Inject, Injectable } from '@nestjs/common';
import {
  MODEL_PROVIDER,
  type ModelProvider,
} from '../../../providers/model/model-provider.interface';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { answerContractSchema, type AnswerContract } from './contracts/answer.contract';
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
 * Turns retrieved evidence into a model-authored `AnswerContract`. This is a generator, not a
 * verifier: it returns exactly what the model produced (parsed and schema-validated by
 * `ModelProvider`, nothing more) — no claim coverage, no verification report, no dropped-claim
 * record. Those are computed by `GroundingGateService` (`./grounding-gate.service.ts`) from this
 * output plus the same `chunks` this call was given; conflating the two would let an unverified
 * model claim reach a caller under the same shape as a gate-checked one.
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
      outputSchema: answerContractSchema,
      maxTokens: MAX_OUTPUT_TOKENS,
      maxCostUsd: MAX_COST_USD,
    });

    return result.output;
  }
}
