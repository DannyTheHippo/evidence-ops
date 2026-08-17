import { Injectable } from '@nestjs/common';
import type { z } from 'zod/v4';
import type {
  ModelProvider,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
  ModelToolCall,
  ModelUsage,
} from './model-provider.interface';

const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/**
 * Test double for `ModelProvider`. Consumers queue results with `enqueue()`; calls beyond the
 * queue throw rather than returning a silently-wrong default, so a test under-mocking its
 * expected call count fails loudly instead of passing on stale data.
 */
@Injectable()
export class FakeModelProvider implements ModelProvider {
  readonly info: ModelProviderInfo = { provider: 'fake', model: 'fake-model' };
  readonly calls: ModelRequest<z.ZodType | undefined>[] = [];

  private readonly queue: Array<ModelResult<z.ZodType | undefined> | Error> = [];

  enqueueResult(result: Partial<ModelResult<z.ZodType | undefined>> & { output: unknown }): void {
    this.queue.push({ usage: ZERO_USAGE, costUsd: 0, ...result });
  }

  /** Convenience for `enqueueResult` when the queued turn is a tool call rather than a final
   * answer — sets `stopReason: 'tool_use'` and the given `toolCalls`, defaulting `output` to an
   * empty string (Anthropic's own shape for a tool-only turn: no leading text block). */
  enqueueToolCall(toolCalls: readonly ModelToolCall[], output: unknown = ''): void {
    this.enqueueResult({ output, stopReason: 'tool_use', toolCalls });
  }

  enqueueError(error: Error): void {
    this.queue.push(error);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    this.calls.push(request);

    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        'FakeModelProvider.generate called with no queued result — call enqueueResult() first',
      );
    }

    if (next instanceof Error) {
      throw next;
    }

    return next;
  }
}
