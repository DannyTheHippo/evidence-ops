import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod/v4';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import { ModelBudgetExceededError } from './errors/model-budget-exceeded.error';
import { UnknownModelPricingError } from './errors/unknown-model-pricing.error';
import type {
  ModelMessage,
  ModelProvider,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
} from './model-provider.interface';
import { estimateTokenCount } from './model-output-validation.util';
import {
  generateWithSchemaRetry,
  REAL_CLOCK,
  type ChatCompletionsTarget,
  type OpenAiClock,
  type OpenAiUsage,
} from './openai-chat-completions.client';
import { computeOpenAiCostUsd, OPENAI_PRICING } from './openai-pricing.table';

export type { OpenAiClock } from './openai-chat-completions.client';

function costUsdForUsage(model: string, usage: OpenAiUsage): number {
  return computeOpenAiCostUsd(model, {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  });
}

/**
 * `fetch`-based, not the vendor SDK — this project deliberately carries no `openai` dependency,
 * following `VoyageEmbeddingProvider`'s precedent. Targets any OpenAI-compatible
 * `/chat/completions` endpoint, so `config.openai.baseUrl` reaching a self-hosted vLLM/Ollama
 * server is a legitimate deployment, not an edge case. The transport and schema-validation retry
 * loop live in `openai-chat-completions.client.ts`, shared with `OpenAiCompatibleModelProvider` —
 * this class supplies only its own namespace (`config.openai`) and its own pricing source (the
 * `OPENAI_PRICING` table).
 */
@Injectable()
export class OpenAiModelProvider implements ModelProvider {
  readonly info: ModelProviderInfo;

  constructor(
    private readonly config: TypedConfigService,
    // `@Optional()` because `OpenAiClock` is an interface — it erases to `Object` at runtime, so
    // Nest has no provider to resolve it against. Unresolvable + optional resolves to
    // `undefined`, which triggers this default just like a direct call would.
    @Optional() private readonly clock: OpenAiClock = REAL_CLOCK,
  ) {
    this.info = { provider: 'openai', model: this.config.openai.model };
  }

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    this.assertBudget(request);

    const { apiKey, baseUrl, timeoutMs } = this.config.openai;
    const target: ChatCompletionsTarget = {
      apiKey,
      baseUrl,
      timeoutMs,
      model: this.info.model,
      clock: this.clock,
    };
    return generateWithSchemaRetry(target, request, 'json_schema', (usage) =>
      costUsdForUsage(this.info.model, usage),
    );
  }

  /**
   * Fails CLOSED: refuses the call outright rather than silently truncating `maxTokens` down to
   * fit the budget. The estimate is worst-case (full `maxTokens` output, prompt-length input
   * estimate) — it can only over-refuse, never under-refuse.
   */
  private assertBudget(request: {
    readonly system?: string;
    readonly messages: readonly ModelMessage[];
    readonly maxTokens: number;
    readonly maxCostUsd: number;
  }): void {
    const pricing = OPENAI_PRICING[this.info.model];
    if (!pricing) {
      throw new UnknownModelPricingError(this.info.model, 'OpenAI', 'openai-pricing.table.ts');
    }

    const promptText = (request.system ?? '') + request.messages.map((m) => m.content).join('');
    const estimatedInputTokens = estimateTokenCount(promptText);
    const estimatedCostUsd =
      (estimatedInputTokens * pricing.input + request.maxTokens * pricing.output) / 1_000_000;

    if (estimatedCostUsd > request.maxCostUsd) {
      throw new ModelBudgetExceededError(estimatedCostUsd, request.maxCostUsd);
    }
  }
}
