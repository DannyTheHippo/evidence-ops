import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod/v4';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import { ANTHROPIC_PRICING, computeAnthropicCostUsd } from './anthropic-pricing.table';
import { UnknownModelPricingError } from './errors/unknown-model-pricing.error';
import { ModelBudgetExceededError } from './errors/model-budget-exceeded.error';
import { ModelSchemaValidationError } from './errors/model-schema-validation.error';
import type {
  ModelMessage,
  ModelOutput,
  ModelProvider,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
  ModelStopReason,
  ModelToolCall,
  ModelToolChoice,
  ModelToolDefinition,
  ModelUsage,
} from './model-provider.interface';
import {
  estimateTokenCount,
  formatIssuesForRetry,
  safeParseModelJson,
} from './model-output-validation.util';
import { toStructuredOutputFormat } from './structured-output-format.util';

/** A `'tool'`-role `ModelMessage` has no dedicated role on Anthropic's side — it becomes a `user`
 * message whose content is a single `tool_result` block naming the `tool_use_id` it answers. */
function toAnthropicToolResultMessage(message: ModelMessage): Anthropic.MessageParam {
  if (!message.toolCallId) {
    throw new Error(
      "A 'tool'-role ModelMessage must carry toolCallId — it identifies which " +
        'tool_use call this result answers',
    );
  }
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }],
  };
}

/** An assistant message with `toolCalls` set becomes `tool_use` content blocks, preceded by a
 * `text` block only when there is text alongside the calls. */
function toAnthropicAssistantMessage(message: ModelMessage): Anthropic.MessageParam {
  const toolUseBlocks: Anthropic.ToolUseBlockParam[] = (message.toolCalls ?? []).map((call) => ({
    type: 'tool_use',
    id: call.id,
    name: call.name,
    input: call.input,
  }));
  const content: Anthropic.ContentBlockParam[] = message.content
    ? [{ type: 'text', text: message.content }, ...toolUseBlocks]
    : toolUseBlocks;
  return { role: 'assistant', content };
}

function toAnthropicMessages(messages: readonly ModelMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return toAnthropicToolResultMessage(message);
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return toAnthropicAssistantMessage(message);
    }
    return { role: message.role, content: message.content };
  });
}

/** `Tool.InputSchema` requires an object-rooted JSON Schema — every tool this codebase defines
 * has an object `inputSchema`, so the cast holds; reuses `toStructuredOutputFormat`'s conversion
 * rather than a second `toJSONSchema` call. */
function toAnthropicTools(
  tools: readonly ModelToolDefinition[] | undefined,
): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toStructuredOutputFormat(tool.inputSchema).schema as Anthropic.Tool.InputSchema,
  }));
}

function toAnthropicToolChoice(
  toolChoice: ModelToolChoice | undefined,
): Anthropic.ToolChoice | undefined {
  if (!toolChoice) {
    return undefined;
  }
  if (toolChoice === 'auto') {
    return { type: 'auto' };
  }
  if (toolChoice === 'none') {
    return { type: 'none' };
  }
  if (toolChoice === 'required') {
    return { type: 'any' };
  }
  return { type: 'tool', name: toolChoice.tool };
}

/** Closed over the three reasons `ModelStopReason` documents — every other Anthropic
 * `stop_reason` (`pause_turn`, `refusal`, `model_context_window_exceeded`, `null`) maps to
 * `undefined` rather than a fabricated guess. */
function toModelStopReason(stopReason: Anthropic.StopReason | null): ModelStopReason | undefined {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return undefined;
  }
}

function extractToolCalls(message: Anthropic.Message): ModelToolCall[] {
  return message.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
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

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    this.assertBudget(request);

    // Widened to the base `z.ZodType` here: TS can't carry the precise narrowing of a generic
    // `TSchema extends z.ZodType | undefined` through a truthy check, and the return values
    // below are cast to `ModelOutput<TSchema>` explicitly anyway.
    const schema: z.ZodType | undefined = request.outputSchema;

    // Built from named fields, never a spread of `request` — `request.passOrdinal` (cache
    // partitioning only, see `ModelRequest`'s own doc comment) has no vendor-API counterpart and
    // must never reach the SDK call below.
    const baseParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.info.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: toAnthropicMessages(request.messages),
      output_config: schema ? { format: toStructuredOutputFormat(schema) } : undefined,
      tools: toAnthropicTools(request.tools),
      tool_choice: toAnthropicToolChoice(request.toolChoice),
      // No `temperature` — this model tier rejects it outright (`400 invalid_request_error:
      // \`temperature\` is deprecated for this model`), so sampling cannot be pinned. See
      // ADR-0006 for what that means for run-to-run reproducibility.
    };

    const first = await this.client.messages.create(baseParams);

    if (!schema) {
      // `stopReason`/`toolCalls` only carry information once a caller offers `tools` — a
      // tool-free request keeps returning exactly what it returned before this field existed.
      const stopReason = request.tools ? toModelStopReason(first.stop_reason) : undefined;
      return {
        output: extractText(first) as ModelOutput<TSchema>,
        usage: toModelUsage(first.usage),
        costUsd: costUsdForUsage(this.info.model, first.usage),
        ...(stopReason ? { stopReason } : {}),
        ...(stopReason === 'tool_use' ? { toolCalls: extractToolCalls(first) } : {}),
      };
    }

    const firstText = extractText(first);
    const firstParsed = safeParseModelJson(firstText, schema);
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
    const retryParsed = safeParseModelJson(retryText, schema);
    const usage = sumUsage(toModelUsage(first.usage), toModelUsage(retry.usage));
    const costUsd =
      costUsdForUsage(this.info.model, first.usage) + costUsdForUsage(this.info.model, retry.usage);

    if (retryParsed.success) {
      return { output: retryParsed.data as ModelOutput<TSchema>, usage, costUsd };
    }

    throw new ModelSchemaValidationError(retryParsed.issues, retryText);
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
