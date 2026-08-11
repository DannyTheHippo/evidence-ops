import { Injectable } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { z } from 'zod/v4';
import type { Telemetry } from '../telemetry/telemetry.interface';
import {
  EVIDENCE_ATTRIBUTES,
  GEN_AI_ATTRIBUTES,
  GEN_AI_CONTENT_EVENTS,
} from '../telemetry/span-attributes.constants';
import type {
  ModelProvider,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
} from './model-provider.interface';

// Module-scope, like every OTel instrumentation library's own tracer: `getTracer` returns a proxy
// that resolves the real tracer provider lazily, on first span, so it's safe to call before
// `instrumentation.ts`'s `NodeSDK.start()` has registered one (or in a test that never does).
const tracer = trace.getTracer('evidence-ops.model');

@Injectable()
export class TracingModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly telemetry: Telemetry,
    // Dev-only (`OTEL_CAPTURE_MODEL_CONTENT`, default false — see environment.config.ts and
    // docs/threat-model.md). Evidence text reaching a trace backend is document content leaving
    // the trust boundary, so this must default OFF and never attach content as a span
    // *attribute* (attributes are far more likely to be indexed/sampled by a backend than events).
    private readonly captureModelContent: boolean = false,
  ) {}

  get info(): ModelProviderInfo {
    return this.inner.info;
  }

  async generate<TSchema extends z.ZodType | undefined = undefined>(
    request: ModelRequest<TSchema>,
  ): Promise<ModelResult<TSchema>> {
    return tracer.startActiveSpan(`model.generate ${request.taskClass}`, async (span) => {
      const startedAt = Date.now();
      span.setAttributes({
        [GEN_AI_ATTRIBUTES.SYSTEM]: this.info.provider,
        [GEN_AI_ATTRIBUTES.REQUEST_MODEL]: this.info.model,
        [GEN_AI_ATTRIBUTES.OPERATION_NAME]: request.taskClass,
      });
      if (this.captureModelContent) {
        span.addEvent(GEN_AI_CONTENT_EVENTS.PROMPT, {
          'gen_ai.prompt': JSON.stringify({ system: request.system, messages: request.messages }),
        });
      }

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
        span.setAttributes({
          [GEN_AI_ATTRIBUTES.RESPONSE_MODEL]: this.info.model,
          [GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS]: result.usage.inputTokens,
          [GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS]: result.usage.outputTokens,
          [EVIDENCE_ATTRIBUTES.COST_USD]: result.costUsd,
        });
        if (this.captureModelContent) {
          span.addEvent(GEN_AI_CONTENT_EVENTS.COMPLETION, {
            'gen_ai.completion': JSON.stringify(result.output),
          });
        }
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
        const err = error instanceof Error ? error : new Error(String(error));
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        this.telemetry.event({
          name: 'model.request.error',
          attributes: {
            taskClass: request.taskClass,
            provider: this.info.provider,
            model: this.info.model,
            durationMs: Date.now() - startedAt,
            error: err.message,
          },
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
