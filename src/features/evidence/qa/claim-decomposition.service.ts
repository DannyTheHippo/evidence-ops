import { Inject, Injectable } from '@nestjs/common';
import type { AnswerUsage } from '../../../database/schemas/evidence/answer/answer.schema';
import {
  MODEL_PROVIDER,
  type ModelProvider,
} from '../../../providers/model/model-provider.interface';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { claimDecompositionContractSchema } from './contracts/claim-decomposition.contract';
import { assembleDecomposeClaimMessages } from './prompts/assemble-decompose-claim-messages';

export interface DecomposeClaimInput {
  readonly statement: string;
  readonly tenantId: string;
}

/** `decomposed` — the model call succeeded and split the statement into atoms; `unavailable` —
 *  the call could not be completed and no atoms were produced. */
export type ClaimDecompositionResult =
  | { readonly kind: 'decomposed'; readonly atoms: readonly string[]; readonly usage: AnswerUsage }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** Bounds this call's output spend: the emitted result is a short list of restated assertions, so
 *  the cap is sized for the model's reasoning plus a handful of short strings, not a full answer. */
const MAX_OUTPUT_TOKENS = 1024;
const MAX_COST_USD = 0.05;

/**
 * Splits one claim statement into the smallest set of self-contained atoms an independent verifier
 * can check individually. `decompose()` never throws: any error from the model call — spend
 * refusal, provider throw, schema-validation exhaustion, timeout — is caught, logged at `warn`,
 * and returned as `{ kind: 'unavailable', reason }`. A caller that receives `unavailable` falls
 * back to verifying the whole claim rather than its atoms, which the monotone atom-verification
 * order (whole claim first, atoms only on a survivor) makes never looser than the per-atom path —
 * so a decomposition that cannot be produced degrades to a stricter check, not a weaker one. A
 * thrown error here would instead fail a verification that would otherwise have passed.
 */
@Injectable()
export class ClaimDecompositionService {
  constructor(
    @Inject(MODEL_PROVIDER)
    private readonly modelProvider: ModelProvider,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(ClaimDecompositionService.name);
  }

  async decompose(input: DecomposeClaimInput): Promise<ClaimDecompositionResult> {
    try {
      const { system, messages } = assembleDecomposeClaimMessages({ claim: input.statement });

      const result = await this.modelProvider.generate({
        taskClass: 'claim_verification',
        system,
        messages,
        outputSchema: claimDecompositionContractSchema,
        maxTokens: MAX_OUTPUT_TOKENS,
        maxCostUsd: MAX_COST_USD,
        tenantId: input.tenantId,
      });

      return {
        kind: 'decomposed',
        atoms: result.output.atoms,
        usage: {
          // Cached tokens are still prompt tokens billed on the call that produced them — same
          // formula `synthesis.service.ts`'s usage computation uses.
          promptTokens:
            result.usage.inputTokens +
            result.usage.cacheCreationInputTokens +
            result.usage.cacheReadInputTokens,
          completionTokens: result.usage.outputTokens,
          costUsd: result.costUsd,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Claim decomposition unavailable, falling back to whole-claim verification: ${reason}`,
      );
      return { kind: 'unavailable', reason };
    }
  }
}
