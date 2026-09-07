import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod/v4';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import { ModelBudgetExceededError } from './errors/model-budget-exceeded.error';
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

/** Neither pricing table (`OPENAI_PRICING`, `VOYAGE_PRICING`) can hold a compatible endpoint's
 * model id — those tables price each vendor's own hosted models, and a self-hosted or third-party
 * endpoint's id is in neither. Cached tokens are priced at the input rate: unlike
 * `OpenAiModelProvider`'s `cachedInput` column, a compatible endpoint's prompt-cache discount is
 * not modelled separately. */
function costUsdForUsage(
  usage: OpenAiUsage,
  priceInputUsdPerMtok: number,
  priceOutputUsdPerMtok: number,
): number {
  return (
    (usage.prompt_tokens * priceInputUsdPerMtok + usage.completion_tokens * priceOutputUsdPerMtok) /
    1_000_000
  );
}

/**
 * Fails CLOSED rather than silently pricing a call at $0. Called when a request is actually priced,
 * never at construction: this class is registered as an ordinary provider, so Nest builds it on
 * every boot regardless of which provider `MODEL_PROVIDER` selects, and refusing in the constructor
 * would make an unset compatible price break the default `anthropic` deployment that never touches
 * this class. `assertCompatiblePricesConfigured` is the construction-time refusal for the boot that
 * does select it.
 */
function requireConfiguredPrice(value: number | undefined, envVar: string): number {
  if (value === undefined) {
    throw new Error(
      `${envVar} is required once MODEL_PROVIDER=openai-compatible selects this provider`,
    );
  }
  return value;
}

/**
 * The construction-time half of the same refusal, run from `createModelProvider` only on the branch
 * that selects this provider — the point where "the compatible provider is in use" is actually
 * known. `environment.config.ts`'s cross-field `superRefine` refuses the same combination at boot;
 * this covers a bypass of it, and keeps the failure at wiring time rather than mid-request.
 */
export function assertCompatiblePricesConfigured(config: TypedConfigService): void {
  requireConfiguredPrice(
    config.openaiCompatible.priceInputUsdPerMtok,
    'OPENAI_COMPATIBLE_PRICE_INPUT_USD_PER_MTOK',
  );
  requireConfiguredPrice(
    config.openaiCompatible.priceOutputUsdPerMtok,
    'OPENAI_COMPATIBLE_PRICE_OUTPUT_USD_PER_MTOK',
  );
}

/**
 * Targets any OpenAI-compatible `/chat/completions` endpoint under its own `OPENAI_COMPATIBLE_*`
 * namespace, independent of an `OPENAI_*` deployment — the two can be configured and swapped
 * between without touching each other. The transport and schema-validation retry loop live in
 * `openai-chat-completions.client.ts`, shared with `OpenAiModelProvider`; this class supplies its
 * own namespace, its own configured pricing, and the structured-output mode knob
 * (`config.openaiCompatible.structuredOutput`).
 */
@Injectable()
export class OpenAiCompatibleModelProvider implements ModelProvider {
  readonly info: ModelProviderInfo;

  constructor(
    private readonly config: TypedConfigService,
    // `@Optional()` because `OpenAiClock` is an interface — it erases to `Object` at runtime, so
    // Nest has no provider to resolve it against. Unresolvable + optional resolves to
    // `undefined`, which triggers this default just like a direct call would.
    @Optional() private readonly clock: OpenAiClock = REAL_CLOCK,
  ) {
    this.info = { provider: 'openai-compatible', model: this.config.openaiCompatible.model };
  }

  private get priceInputUsdPerMtok(): number {
    return requireConfiguredPrice(
      this.config.openaiCompatible.priceInputUsdPerMtok,
      'OPENAI_COMPATIBLE_PRICE_INPUT_USD_PER_MTOK',
    );
  }

  private get priceOutputUsdPerMtok(): number {
    return requireConfiguredPrice(
      this.config.openaiCompatible.priceOutputUsdPerMtok,
      'OPENAI_COMPATIBLE_PRICE_OUTPUT_USD_PER_MTOK',
    );
  }

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    this.assertBudget(request);

    const { apiKey, baseUrl, timeoutMs, structuredOutput } = this.config.openaiCompatible;
    const target: ChatCompletionsTarget = {
      apiKey,
      baseUrl,
      timeoutMs,
      model: this.info.model,
      clock: this.clock,
    };
    return generateWithSchemaRetry(target, request, structuredOutput, (usage) =>
      costUsdForUsage(usage, this.priceInputUsdPerMtok, this.priceOutputUsdPerMtok),
    );
  }

  /**
   * Fails CLOSED: refuses the call outright rather than silently truncating `maxTokens` down to
   * fit the budget. Configured prices of `0` never refuse (a genuinely free self-hosted model),
   * matching `OPENAI_PRICING`'s explicit-zero convention for the same class of deployment.
   */
  private assertBudget(request: {
    readonly system?: string;
    readonly messages: readonly ModelMessage[];
    readonly maxTokens: number;
    readonly maxCostUsd: number;
  }): void {
    const promptText = (request.system ?? '') + request.messages.map((m) => m.content).join('');
    const estimatedInputTokens = estimateTokenCount(promptText);
    const estimatedCostUsd =
      (estimatedInputTokens * this.priceInputUsdPerMtok +
        request.maxTokens * this.priceOutputUsdPerMtok) /
      1_000_000;

    if (estimatedCostUsd > request.maxCostUsd) {
      throw new ModelBudgetExceededError(estimatedCostUsd, request.maxCostUsd);
    }
  }
}
