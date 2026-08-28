import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod/v4';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import { ANTHROPIC_PRICING, computeAnthropicCostUsd } from './anthropic-pricing.table';
import { UnknownModelPricingError } from './errors/unknown-model-pricing.error';
import { ModelBudgetExceededError } from './errors/model-budget-exceeded.error';
import { ModelOutputTruncatedError } from './errors/model-output-truncated.error';
import { ModelSchemaValidationError } from './errors/model-schema-validation.error';
import type {
  ModelMessage,
  ModelOutput,
  ModelProvider,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
  ModelUsage,
} from './model-provider.interface';
import {
  estimateTokenCount,
  formatIssuesForRetry,
  safeParseModelJson,
} from './model-output-validation.util';
import { toStructuredOutputFormat } from './structured-output-format.util';

function toAnthropicMessages(messages: readonly ModelMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function toModelUsage(usage: Anthropic.Usage): ModelUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function sumUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

/** Stop reasons under which the SDK's `StopReason` union means generation was cut off before
 *  completing rather than finishing on its own terms — the output cap, or the model's context
 *  window filling up. Every other reason (`end_turn`, `stop_sequence`, `tool_use`, `pause_turn`,
 *  `refusal`) means the response is exactly as long as the model intended it to be. */
const TRUNCATION_STOP_REASONS: ReadonlySet<Anthropic.StopReason> = new Set([
  'max_tokens',
  'model_context_window_exceeded',
]);

function isTruncationStopReason(
  stopReason: Anthropic.StopReason | null,
): stopReason is Anthropic.StopReason {
  return stopReason !== null && TRUNCATION_STOP_REASONS.has(stopReason);
}

function costUsdForUsage(model: string, usage: Anthropic.Usage): number {
  return computeAnthropicCostUsd(model, {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens,
    cacheCreation5mInputTokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    cacheCreation1hInputTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  });
}

/**
 * Wraps the system prompt as a single cache-eligible content block — Anthropic only honours
 * `cache_control` on an explicit block, never on the plain-string shorthand `system` also
 * accepts. Below this model tier's ~1024-token cacheable minimum, marking a block cacheable is a
 * harmless no-op: no cache entry is created and usage/cost are unaffected. The extraction system
 * prompt (~1,250 tokens, repeated verbatim across `passOrdinal` passes) sits comfortably above
 * that minimum, so its passes after the first read from cache instead of paying full input price
 * each time.
 */
function toAnthropicSystem(system: string | undefined): Anthropic.TextBlockParam[] | undefined {
  if (!system) {
    return undefined;
  }
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

@Injectable()
export class AnthropicModelProvider implements ModelProvider {
  readonly info: ModelProviderInfo;

  private readonly client: Anthropic;

  constructor(private readonly config: TypedConfigService) {
    // The SDK auto-retries transient failures (network errors, 5XX) twice by default with
    // backoff honouring `retry-after`; we do not stack a retry loop on top of it. The retry
    // implemented below is for schema-validation failure only, a different failure class.
    this.client = new Anthropic({
      apiKey: this.config.anthropic.apiKey,
      timeout: this.config.anthropic.timeoutMs,
    });
    this.info = { provider: 'anthropic', model: this.config.anthropic.model };
  }

  /**
   * The model a given `taskClass` actually routes to — resolved per call, never cached on
   * `this.info.model` at construction, because a decorator (`CachingModelProvider`'s replay-cache
   * key, `SpendGuardModelProvider`'s pricing) must be able to ask this *before* a call is made.
   *
   * `fact_extraction` is the only task class this project's operators can currently retarget
   * (`ANTHROPIC_MODEL_FACT_EXTRACTION`); unset, it falls back to `info.model` — the same model
   * every task class used before this override existed. `claim_verification` and `qa_answer` are
   * pinned to `info.model` unconditionally: this project keeps claim verification on the stronger
   * model regardless of configuration.
   */
  resolveModel(taskClass: ModelRequest['taskClass']): string {
    if (taskClass === 'fact_extraction') {
      return this.config.anthropic.factExtractionModel ?? this.info.model;
    }
    return this.info.model;
  }

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    const model = this.resolveModel(request.taskClass);
    this.assertBudget(request, model);

    // Widened to the base `z.ZodType` here: TS can't carry the precise narrowing of a generic
    // `TSchema extends z.ZodType | undefined` through a truthy check, and the return values
    // below are cast to `ModelOutput<TSchema>` explicitly anyway.
    const schema: z.ZodType | undefined = request.outputSchema;

    // Built from named fields, never a spread of `request` — `request.passOrdinal` (cache
    // partitioning only, see `ModelRequest`'s own doc comment) has no vendor-API counterpart and
    // must never reach the SDK call below.
    const baseParams: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: request.maxTokens,
      system: toAnthropicSystem(request.system),
      messages: toAnthropicMessages(request.messages),
      output_config: schema ? { format: toStructuredOutputFormat(schema) } : undefined,
      // No `temperature` — this model tier rejects it outright (`400 invalid_request_error:
      // \`temperature\` is deprecated for this model`), so sampling cannot be pinned. See
      // ADR-0006 for what that means for run-to-run reproducibility.
    };

    const first = await this.client.messages.create(baseParams);

    if (!schema) {
      // A truncated free-text answer is the caller's business, not a hard failure here — with no
      // outputSchema there is no downstream parse a truncation would break, so the text comes
      // back as-is regardless of stop_reason.
      return {
        output: extractText(first) as ModelOutput<TSchema>,
        usage: toModelUsage(first.usage),
        costUsd: costUsdForUsage(model, first.usage),
      };
    }

    const firstText = extractText(first);
    const firstParsed = safeParseModelJson(firstText, schema);
    if (firstParsed.success) {
      // A response is valid regardless of why generation stopped — a `stop_reason` that would
      // otherwise mean truncation is moot once the emitted text has already parsed and validated.
      return {
        output: firstParsed.data as ModelOutput<TSchema>,
        usage: toModelUsage(first.usage),
        costUsd: costUsdForUsage(model, first.usage),
      };
    }

    // Consulted only once the parse/validation above has already failed: the cap signal explains
    // *why* an unparseable response is unparseable, it does not by itself mean the response is
    // bad. A response cut off this way is incomplete by construction, so entering the
    // schema-validation retry below would resend the same (or a longer) prompt against the same
    // constraint and reproduce the same cutoff — that retry is a real billed request.
    if (isTruncationStopReason(first.stop_reason)) {
      throw new ModelOutputTruncatedError(
        first.stop_reason,
        request.maxTokens,
        first.usage.output_tokens,
        firstText,
      );
    }

    // Exactly one retry, feeding the validation errors back to the model. Usage/cost from both
    // calls accumulate — the retry is a real billed request.
    const correctionMessage: Anthropic.MessageParam = {
      role: 'user',
      content: `Your previous response failed schema validation:\n${formatIssuesForRetry(firstParsed.issues)}\n\nReturn ONLY corrected JSON matching the schema.`,
    };
    // Anthropic rejects an empty assistant content block outright. When the model spent its
    // whole budget on thinking and produced no visible (non-whitespace) text, there is nothing to
    // echo back, so the correction turn is appended directly rather than preceded by an empty
    // assistant turn.
    const retryParams: Anthropic.MessageCreateParamsNonStreaming = {
      ...baseParams,
      messages: firstText.trim()
        ? [...baseParams.messages, { role: 'assistant', content: firstText }, correctionMessage]
        : [...baseParams.messages, correctionMessage],
    };

    const retry = await this.client.messages.create(retryParams);
    const retryText = extractText(retry);
    const retryParsed = safeParseModelJson(retryText, schema);
    const usage = sumUsage(toModelUsage(first.usage), toModelUsage(retry.usage));
    const costUsd = costUsdForUsage(model, first.usage) + costUsdForUsage(model, retry.usage);

    if (retryParsed.success) {
      return { output: retryParsed.data as ModelOutput<TSchema>, usage, costUsd };
    }

    if (isTruncationStopReason(retry.stop_reason)) {
      throw new ModelOutputTruncatedError(
        retry.stop_reason,
        request.maxTokens,
        retry.usage.output_tokens,
        retryText,
      );
    }

    throw new ModelSchemaValidationError(retryParsed.issues, retryText);
  }

  /**
   * Fails CLOSED: refuses the call outright rather than silently truncating `maxTokens` down to
   * fit the budget. The estimate is worst-case (full `maxTokens` output, prompt-length input
   * estimate) — it can only over-refuse, never under-refuse.
   *
   * Priced against `model` — the per-request resolution from `resolveModel`, not `info.model` —
   * so a task class routed to a cheaper or more expensive model is budgeted against what it will
   * actually be billed, not the provider's default.
   */
  private assertBudget(
    request: {
      readonly system?: string;
      readonly messages: readonly ModelMessage[];
      readonly maxTokens: number;
      readonly maxCostUsd: number;
    },
    model: string,
  ): void {
    const pricing = ANTHROPIC_PRICING[model];
    if (!pricing) {
      throw new UnknownModelPricingError(model);
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
