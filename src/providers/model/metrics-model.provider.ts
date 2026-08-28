import { Injectable } from '@nestjs/common';
import type { z } from 'zod/v4';
import { modelCostHistogram } from '../telemetry/domain-metrics';
import type { Telemetry } from '../telemetry/telemetry.interface';
import type {
  ModelProvider,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
} from './model-provider.interface';

/**
 * Records model spend and call outcomes: `modelCostHistogram` (`domain-metrics.ts`) for per-call
 * cost, and `model.request.start` / `model.request.success` / `model.request.error` events
 * through `Telemetry` for structured logging. Carries no span, tracer, or other OTel tracing
 * surface — `domain-metrics.ts`'s metrics API is the only OTel surface this class touches.
 */
@Injectable()
export class MetricsModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly telemetry: Telemetry,
  ) {}

  get info(): ModelProviderInfo {
    return this.inner.info;
  }

  /** Forwards to the delegate — see `ModelProvider.resolveModel`'s own doc comment for why every
   * decorator in the chain must do this rather than let it fall back silently. */
  resolveModel(taskClass: ModelRequest['taskClass']): string {
    return this.inner.resolveModel?.(taskClass) ?? this.inner.info.model;
  }

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    const startedAt = Date.now();
    const model = this.resolveModel(request.taskClass);
    this.telemetry.event({
      name: 'model.request.start',
      attributes: {
        taskClass: request.taskClass,
        provider: this.info.provider,
        model,
      },
    });

    try {
      const result = await this.inner.generate(request);
      modelCostHistogram.record(result.costUsd, {
        provider: this.info.provider,
        taskClass: request.taskClass,
      });
      this.telemetry.event({
        name: 'model.request.success',
        attributes: {
          taskClass: request.taskClass,
          provider: this.info.provider,
          model,
          usage: result.usage,
          costUsd: result.costUsd,
          durationMs: Date.now() - startedAt,
        },
      });
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.telemetry.event({
        name: 'model.request.error',
        attributes: {
          taskClass: request.taskClass,
          provider: this.info.provider,
          model,
          durationMs: Date.now() - startedAt,
          error: err.message,
        },
      });
      throw error;
    }
  }
}
