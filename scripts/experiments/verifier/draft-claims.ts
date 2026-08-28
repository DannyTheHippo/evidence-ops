import { z } from 'zod/v4';
import type { ModelProvider } from '../../../src/providers/model/model-provider.interface';
import { assembleDraftingMessages } from './assemble-drafting-messages';
import type { CorpusDocument } from './types';

/** Output headroom per requested statement, plus a fixed allowance for the JSON envelope. */
const TOKENS_PER_STATEMENT = 120;
const ENVELOPE_TOKENS = 256;

/** Worst-case spend ceiling for one drafting call, refused before the call rather than after.
 *  Sized for a whole file in the prompt and a few thousand output tokens. */
const MAX_COST_USD = 0.5;

/** A document whose chunks exceed this stops the run. Silently truncating the prompt would leave a
 *  claim drafted from part of a file indistinguishable from one drafted from all of it. */
export const DRAFTING_INPUT_TOKEN_BUDGET = 60_000;

export interface DraftClaimsInput {
  readonly document: CorpusDocument;
  readonly statementCount: number;
  readonly maxStatementLength: number;
  readonly tenantId: string;
  /** Partitions the replay cache so a re-drafted pass is a genuine re-sample, not a replay of an
   *  earlier pass over the same prompt. */
  readonly passOrdinal: number;
}

/**
 * Runs one analyst-voiced drafting pass over one document and returns its statements, trimmed and
 * with empties dropped.
 *
 * `taskClass` is `qa_answer`: the closed `TaskClass` union has no drafting member, and this pass is
 * prose written about retrieved evidence, which is the class `qa_answer` already routes.
 */
export async function draftClaims(
  modelProvider: ModelProvider,
  input: DraftClaimsInput,
): Promise<readonly string[]> {
  const documentTokens = input.document.chunks.reduce(
    (total, chunk) => total + chunk.tokenCount,
    0,
  );
  if (documentTokens > DRAFTING_INPUT_TOKEN_BUDGET) {
    throw new Error(
      `draftClaims: '${input.document.filename}' is ${documentTokens} tokens, above the ` +
        `${DRAFTING_INPUT_TOKEN_BUDGET}-token drafting budget`,
    );
  }

  const outputSchema = z
    .object({
      statements: z.array(z.string().min(1).max(input.maxStatementLength)).min(1),
    })
    .strict();

  const { system, messages } = assembleDraftingMessages(input.document, input.statementCount);
  const result = await modelProvider.generate({
    taskClass: 'qa_answer',
    system,
    messages,
    outputSchema,
    maxTokens: input.statementCount * TOKENS_PER_STATEMENT + ENVELOPE_TOKENS,
    maxCostUsd: MAX_COST_USD,
    passOrdinal: input.passOrdinal,
    tenantId: input.tenantId,
  });

  return result.output.statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
