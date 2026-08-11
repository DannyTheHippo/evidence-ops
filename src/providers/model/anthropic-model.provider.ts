import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod/v4';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import { ANTHROPIC_PRICING, computeAnthropicCostUsd } from './anthropic-pricing.table';
import { UnknownModelPricingError } from './errors/unknown-model-pricing.error';
import { ModelBudgetExceededError } from './errors/model-budget-exceeded.error';
import {
  ModelSchemaValidationError,
  type ModelValidationIssue,
} from './errors/model-schema-validation.error';
import type {
  ModelMessage,
  ModelOutput,
  ModelProvider,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
  ModelUsage,
} from './model-provider.interface';
import { resolveSamplingTemperature } from './sampling-params';
import { toStructuredOutputFormat } from './structured-output-format.util';

/**
 * Rough chars-per-token heuristic (~4 chars/token for English) used only to pre-flight the
 * budget check before a call is made. Never used for billing — actual cost always comes from
 * the vendor's real `usage` counters after the call.
 */
const ESTIMATED_CHARS_PER_TOKEN = 4;

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

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

function costUsdForUsage(model: string, usage: Anthropic.Usage): number {
  return computeAnthropicCostUsd(model, {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens,
    cacheCreation5mInputTokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    cacheCreation1hInputTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  });
}

function formatIssuesForRetry(issues: readonly ModelValidationIssue[]): string {
  return issues
    .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

@Injectable()
export class AnthropicModelProvider implements ModelProvider {
  readonly info: ModelProviderInfo;

  private readonly client: Anthropic;

  constructor(private readonly config: TypedConfigService) {
    // The SDK auto-retries transient failures (network errors, 5XX) twice by default with
    // backoff honouring `retry-after`; we do not stack a retry loop on top of it. The retry
    // implemented below is for schema-validation failure only, a different failure class.
    this.client = new Anthropic({ apiKey: this.config.anthropic.apiKey });
    this.info = { provider: 'anthropic', model: this.config.anthropic.model };
  }

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    this.assertBudget(request);

    // Widened to the base `z.ZodType` here: TS can't carry the precise narrowing of a generic
    // `TSchema extends z.ZodType | undefined` through a truthy check, and the return values
    // below are cast to `ModelOutput<TSchema>` explicitly anyway.
    const schema: z.ZodType | undefined = request.outputSchema;

    const baseParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.info.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: toAnthropicMessages(request.messages),
      output_config: schema ? { format: toStructuredOutputFormat(schema) } : undefined,
      // Pinned per `taskClass`, not left at the API default — see `sampling-params.ts` for why
      // (unpinned sampling let a seeded conflict silently stop being detected).
      temperature: resolveSamplingTemperature(request.taskClass),
    };

    const first = await this.client.messages.create(baseParams);

    if (!schema) {
      return {
        output: extractText(first) as ModelOutput<TSchema>,
        usage: toModelUsage(first.usage),
        costUsd: costUsdForUsage(this.info.model, first.usage),
      };
    }

    const firstText = extractText(first);
    const firstParsed = this.safeParseJson(firstText, schema);
    if (firstParsed.success) {
      return {
        output: firstParsed.data as ModelOutput<TSchema>,
        usage: toModelUsage(first.usage),
        costUsd: costUsdForUsage(this.info.model, first.usage),
      };
    }

    // Exactly one retry, feeding the validation errors back to the model. Usage/cost from both
    // calls accumulate — the retry is a real billed request.
    const retryParams: Anthropic.MessageCreateParamsNonStreaming = {
      ...baseParams,
      messages: [
        ...baseParams.messages,
        { role: 'assistant', content: firstText },
        {
          role: 'user',
          content: `Your previous response failed schema validation:\n${formatIssuesForRetry(firstParsed.issues)}\n\nReturn ONLY corrected JSON matching the schema.`,
        },
      ],
    };

    const retry = await this.client.messages.create(retryParams);
    const retryText = extractText(retry);
    const retryParsed = this.safeParseJson(retryText, schema);
    const usage = sumUsage(toModelUsage(first.usage), toModelUsage(retry.usage));
    const costUsd =
      costUsdForUsage(this.info.model, first.usage) + costUsdForUsage(this.info.model, retry.usage);

    if (retryParsed.success) {
      return { output: retryParsed.data as ModelOutput<TSchema>, usage, costUsd };
    }

    throw new ModelSchemaValidationError(retryParsed.issues, retryText);
  }

  private safeParseJson<TSchema extends z.ZodType>(
    text: string,
    schema: TSchema,
  ):
    { success: true; data: z.infer<TSchema> } | { success: false; issues: ModelValidationIssue[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        issues: [{ path: [], message: `Response is not valid JSON: ${message}` }],
      };
    }

    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data };
    }

    return {
      success: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String),
        message: issue.message,
      })),
    };
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
    const pricing = ANTHROPIC_PRICING[this.info.model];
    if (!pricing) {
      throw new UnknownModelPricingError(this.info.model);
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
