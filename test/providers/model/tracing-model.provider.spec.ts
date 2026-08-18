import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { FakeModelProvider } from '../../../src/providers/model/fake-model.provider';
import type { ModelRequest } from '../../../src/providers/model/model-provider.interface';
import { TracingModelProvider } from '../../../src/providers/model/tracing-model.provider';
import { modelCostHistogram } from '../../../src/providers/telemetry/domain-metrics';
import type { Telemetry } from '../../../src/providers/telemetry/telemetry.interface';

/**
 * Registers a real in-memory tracer provider rather than stubbing `trace.getTracer`.
 *
 * `tracing-model.provider.ts` resolves its tracer once at module scope, so a `jest.spyOn` in
 * `beforeEach` is captured too late to have any effect — the provider keeps writing to the real
 * proxy tracer while the test inspects a stub nothing touches, and every "no secret in the span"
 * assertion passes vacuously. Asserting over exported spans is what makes these tests capable of
 * failing.
 */
const exporter = new InMemorySpanExporter();

const SECRET_PROMPT = 'CANARY-PROMPT-TEXT-must-never-be-traced';
const SECRET_COMPLETION = 'CANARY-COMPLETION-TEXT-must-never-be-traced';

describe('TracingModelProvider', () => {
  let telemetry: Telemetry;
  let inner: FakeModelProvider;

  const request: ModelRequest<undefined> = {
    taskClass: 'qa_answer',
    system: 'You answer only from the supplied evidence.',
    messages: [{ role: 'user', content: SECRET_PROMPT }],
    maxTokens: 128,
    maxCostUsd: 1,
  };

  beforeAll(() => {
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });

  afterAll(() => {
    trace.disable();
  });

  beforeEach(() => {
    exporter.reset();
    telemetry = { event: jest.fn() };
    inner = new FakeModelProvider();
    // `modelCostHistogram` is a module-scope singleton (not a fresh instance per test like
    // `telemetry`/`inner` above), so `jest.spyOn` in an individual test would otherwise return the
    // same mock — and its accumulated call history — across every test in this file.
    jest.spyOn(modelCostHistogram, 'record').mockClear();
  });

  function onlySpan(): ReadableSpan {
    const spans = exporter.getFinishedSpans();
    // A vacuous pass here would mean the provider never opened a span at all, which the
    // secret-absence assertions below could not distinguish from correct redaction.
    expect(spans).toHaveLength(1);
    return spans[0];
  }

  it('should never attach prompt or completion text to a span when capture is off', async () => {
    const provider = new TracingModelProvider(inner, telemetry, false);
    inner.enqueueResult({ output: SECRET_COMPLETION });

    await provider.generate(request);
    const span = onlySpan();

    // Serialized whole rather than checked key by key: an attribute added later without thinking
    // about disclosure has to fail this, which a list of known keys could never catch.
    const serialized = JSON.stringify({ attributes: span.attributes, events: span.events });
    expect(serialized).not.toContain(SECRET_PROMPT);
    expect(serialized).not.toContain(SECRET_COMPLETION);
    expect(span.events).toHaveLength(0);
  });

  it('should still record cost and token usage when capture is off', async () => {
    const provider = new TracingModelProvider(inner, telemetry, false);
    inner.enqueueResult({ output: SECRET_COMPLETION });

    await provider.generate(request);
    const span = onlySpan();

    // The disclosure control must not cost the observability this decorator exists to provide.
    expect(span.attributes['gen_ai.usage.input_tokens']).toBeDefined();
    expect(span.attributes['gen_ai.usage.output_tokens']).toBeDefined();
    expect(span.attributes['evidence.cost_usd']).toBeDefined();
  });

  it('should carry content as span events and never as attributes when capture is on', async () => {
    const provider = new TracingModelProvider(inner, telemetry, true);
    inner.enqueueResult({ output: SECRET_COMPLETION });

    await provider.generate(request);
    const span = onlySpan();

    // Events, not attributes: backends commonly index and sample attributes by default while
    // leaving event bodies alone, so that distinction is the whole of the mitigation.
    expect(JSON.stringify(span.attributes)).not.toContain(SECRET_PROMPT);
    expect(JSON.stringify(span.attributes)).not.toContain(SECRET_COMPLETION);
    expect(JSON.stringify(span.events)).toContain(SECRET_PROMPT);
    expect(JSON.stringify(span.events)).toContain(SECRET_COMPLETION);
  });

  it('should default to capture off when the flag is not supplied', async () => {
    // The constructor default governs any caller that omits the argument, so it is asserted
    // independently of the wiring in `providers.module.ts`.
    const provider = new TracingModelProvider(inner, telemetry);
    inner.enqueueResult({ output: SECRET_COMPLETION });

    await provider.generate(request);
    const span = onlySpan();

    expect(JSON.stringify({ attributes: span.attributes, events: span.events })).not.toContain(
      SECRET_COMPLETION,
    );
  });

  it('should record the call cost on the domain cost histogram, by provider and taskClass', async () => {
    const costHistogramSpy = jest.spyOn(modelCostHistogram, 'record');
    const provider = new TracingModelProvider(inner, telemetry, false);
    inner.enqueueResult({ output: SECRET_COMPLETION, costUsd: 0.042 });

    await provider.generate(request);

    expect(costHistogramSpy).toHaveBeenCalledWith(0.042, {
      provider: 'fake',
      taskClass: 'qa_answer',
    });
  });

  it('should not record a cost on the domain cost histogram when the inner provider fails', async () => {
    const costHistogramSpy = jest.spyOn(modelCostHistogram, 'record');
    const provider = new TracingModelProvider(inner, telemetry, false);
    inner.enqueueError(new Error('upstream refused'));

    await expect(provider.generate(request)).rejects.toThrow('upstream refused');

    expect(costHistogramSpy).not.toHaveBeenCalled();
  });

  it('should mark the span as errored and rethrow when the inner provider fails', async () => {
    const provider = new TracingModelProvider(inner, telemetry, false);
    inner.enqueueError(new Error('upstream refused'));

    await expect(provider.generate(request)).rejects.toThrow('upstream refused');

    const span = onlySpan();
    expect(span.status.code).toBe(2);
    expect(span.events.some((event) => event.name === 'exception')).toBe(true);
  });

  it('should not leak prompt text through the exception path when capture is off', async () => {
    // The error path writes `recordException`, which serializes a message the caller controls —
    // a redaction gap here would be invisible to the happy-path assertions above.
    const provider = new TracingModelProvider(inner, telemetry, false);
    inner.enqueueError(new Error(`upstream refused: ${SECRET_PROMPT}`));

    await expect(provider.generate(request)).rejects.toThrow('upstream refused');

    const span = onlySpan();
    expect(JSON.stringify({ attributes: span.attributes })).not.toContain(SECRET_PROMPT);
  });
});
