import { z } from 'zod/v4';
import { computeCacheKey, type CacheKeyInput } from '../../../src/providers/model/cache-key.util';

describe('computeCacheKey', () => {
  const baseInput: CacheKeyInput = {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    maxTokens: 512,
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'hello' }],
  };

  it('should be stable regardless of the caller field order', () => {
    const a = computeCacheKey(baseInput);
    const b = computeCacheKey({
      messages: baseInput.messages,
      system: baseInput.system,
      maxTokens: baseInput.maxTokens,
      model: baseInput.model,
      provider: baseInput.provider,
    });

    expect(a).toBe(b);
  });

  it('should be stable regardless of key order within a nested message object', () => {
    const a = computeCacheKey(baseInput);
    const b = computeCacheKey({
      ...baseInput,
      messages: [{ content: 'hello', role: 'user' }],
    });

    expect(a).toBe(b);
  });

  it('should differ when the model changes', () => {
    const a = computeCacheKey(baseInput);
    const b = computeCacheKey({ ...baseInput, model: 'claude-opus-5' });

    expect(a).not.toBe(b);
  });

  it('should differ when a param (maxTokens) changes', () => {
    const a = computeCacheKey(baseInput);
    const b = computeCacheKey({ ...baseInput, maxTokens: 1024 });

    expect(a).not.toBe(b);
  });

  it('should differ when the prompt system text changes', () => {
    const a = computeCacheKey(baseInput);
    const b = computeCacheKey({ ...baseInput, system: 'You are a pirate.' });

    expect(a).not.toBe(b);
  });

  it('should differ when the prompt messages change', () => {
    const a = computeCacheKey(baseInput);
    const b = computeCacheKey({
      ...baseInput,
      messages: [{ role: 'user', content: 'goodbye' }],
    });

    expect(a).not.toBe(b);
  });

  it('should differ when the output schema shape changes', () => {
    const a = computeCacheKey({ ...baseInput, outputSchema: z.object({ answer: z.string() }) });
    const b = computeCacheKey({ ...baseInput, outputSchema: z.object({ answer: z.number() }) });

    expect(a).not.toBe(b);
  });

  it('should differ between having a schema and having none', () => {
    const withSchema = computeCacheKey({
      ...baseInput,
      outputSchema: z.object({ answer: z.string() }),
    });
    const withoutSchema = computeCacheKey(baseInput);

    expect(withSchema).not.toBe(withoutSchema);
  });

  // Fixture-compatibility regression: every fixture under `eval/cache/model/` was recorded
  // before `passOrdinal` existed. If an absent/undefined `passOrdinal` changed the key, every one
  // of those fixtures would go stale on this change alone.
  it('should produce the same key whether passOrdinal is omitted or explicitly undefined', () => {
    const omitted = computeCacheKey(baseInput);
    const explicitlyUndefined = computeCacheKey({ ...baseInput, passOrdinal: undefined });

    expect(explicitlyUndefined).toBe(omitted);
  });

  it('should differ across three distinct passOrdinal values, partitioning identical prompts into distinct cache entries', () => {
    const pass0 = computeCacheKey({ ...baseInput, passOrdinal: 0 });
    const pass1 = computeCacheKey({ ...baseInput, passOrdinal: 1 });
    const pass2 = computeCacheKey({ ...baseInput, passOrdinal: 2 });

    expect(new Set([pass0, pass1, pass2]).size).toBe(3);
  });

  it('should differ from the passOrdinal-less key once passOrdinal is set', () => {
    const withoutPassOrdinal = computeCacheKey(baseInput);
    const withPassOrdinal = computeCacheKey({ ...baseInput, passOrdinal: 0 });

    expect(withPassOrdinal).not.toBe(withoutPassOrdinal);
  });
});
