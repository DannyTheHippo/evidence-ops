import { Inject, Injectable } from '@nestjs/common';
import {
  MODEL_PROVIDER,
  type ModelProvider,
} from '../../../providers/model/model-provider.interface';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { contradictionCheckContractSchema } from './contracts/contradiction-check.contract';
import { assembleContradictionCheckMessages } from './prompts/assemble-contradiction-check-messages';
import type { RetrievedChunk } from './types/retrieved-chunk.type';

export interface ContradictionCheckInput {
  readonly atom: string;
  readonly evidence: readonly RetrievedChunk[];
  readonly tenantId: string;
}

export interface ContradictionCheckUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
}

/** `checked` — the model call succeeded and returned an opinion; `unavailable` — the call could
 *  not be completed and nothing about the claim it was checking has changed as a result. */
export type ContradictionCheckResult =
  | {
      readonly kind: 'checked';
      readonly contradicted: boolean;
      readonly usage: ContradictionCheckUsage;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** Bounds this call's output spend: the emitted result is a single boolean, so the cap is sized
 *  for the model's reasoning rather than the answer itself. */
const MAX_OUTPUT_TOKENS = 512;
const MAX_COST_USD = 0.05;

/**
 * A veto-only gate on a claim that has already survived every other check, never a check of its
 * own. Its entire output alphabet is one boolean (`contradictionCheckContractSchema`), which is
 * what makes it structurally incapable of authoring a verdict: it can only LOWER a verdict this
 * codebase already computed, via `reasonCode: 'claim-contradicted'`, never raise one. Callers MUST
 * invoke this on survivors only — a claim that has not yet survived every deterministic check has
 * no verdict for this service to lower, and calling it earlier would let its opinion stand in for
 * one of those checks.
 *
 * Fails OPEN: `check()` never throws. Any error from the model call — spend refusal, provider
 * throw, schema-validation exhaustion, timeout — is caught, logged at `warn`, and returned as
 * `{ kind: 'unavailable', reason }`, which changes nothing about the claim under check. A
 * veto-only gate whose measurement is broken must never block the thing it measures.
 */
@Injectable()
export class ContradictionCheckService {
  constructor(
    @Inject(MODEL_PROVIDER)
    private readonly modelProvider: ModelProvider,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(ContradictionCheckService.name);
  }

  async check(input: ContradictionCheckInput): Promise<ContradictionCheckResult> {
    try {
      const { system, messages } = assembleContradictionCheckMessages({
        atom: input.atom,
        evidence: input.evidence,
      });

      const result = await this.modelProvider.generate({
        taskClass: 'claim_verification',
        system,
        messages,
        outputSchema: contradictionCheckContractSchema,
        maxTokens: MAX_OUTPUT_TOKENS,
        maxCostUsd: MAX_COST_USD,
        tenantId: input.tenantId,
      });

      return {
        kind: 'checked',
        contradicted: result.output.contradicted,
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
        `Contradiction check unavailable, leaving the claim's verdict unchanged: ${reason}`,
      );
      return { kind: 'unavailable', reason };
    }
  }
}
