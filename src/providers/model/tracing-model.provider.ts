import { Injectable } from '@nestjs/common';
import type { z } from 'zod/v4';
import type { Telemetry } from '../telemetry/telemetry.interface';
import type {
  ModelProvider,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
} from './model-provider.interface';

@Injectable()
export class TracingModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly telemetry: Telemetry,
  ) {}

  get info(): ModelProviderInfo {
    return this.inner.info;
  }

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    const startedAt = Date.now();
    this.telemetry.event({
      name: 'model.request.start',
      attributes: {
        taskClass: request.taskClass,
        provider: this.info.provider,
        model: this.info.model,
      },
    });

    try {
      const result = await this.inner.generate(request);
      this.telemetry.event({
        name: 'model.request.success',
        attributes: {
          taskClass: request.taskClass,
          provider: this.info.provider,
          model: this.info.model,
          usage: result.usage,
          costUsd: result.costUsd,
          durationMs: Date.now() - startedAt,
        },
      });
      return result;
    } catch (error) {
      this.telemetry.event({
        name: 'model.request.error',
        attributes: {
          taskClass: request.taskClass,
          provider: this.info.provider,
          model: this.info.model,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }
}
