import { readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { computeCacheKey, type CacheKeyInput } from '../../../src/providers/model/cache-key.util';
import type { ModelToolDefinition } from '../../../src/providers/model/model-provider.interface';

const EVAL_MODEL_CACHE_DIR = path.join(__dirname, '../../../eval/cache/model');

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

  // Corpus-compatibility proof, not just an assertion: every fixture under `eval/cache/model/`
  // was recorded before `tools`/`toolChoice` existed on `CacheKeyInput`. This literal hash was
  // captured from `computeCacheKey(baseInput)` against the pre-`tools` version of this file
  // (`git show HEAD:src/providers/model/cache-key.util.ts` at the commit before this change) and
  // must stay byte-identical — a single character of drift here is exactly what would silently
  // invalidate every committed fixture.
  it('should hash a tool-free request identically to before tools/toolChoice existed on CacheKeyInput', () => {
    expect(computeCacheKey(baseInput)).toBe(
      '758b825f4eb2012f7bd708229d7c499daa7f4849935acf0a9d0febdc10689e1d',
    );
  });

  const oneTool: readonly ModelToolDefinition[] = [
    {
      name: 'lookup',
      description: 'Looks something up.',
      inputSchema: z.object({ id: z.string() }),
    },
  ];

  it('should produce the same key whether tools is omitted or explicitly undefined', () => {
    const omitted = computeCacheKey(baseInput);
    const explicitlyUndefined = computeCacheKey({ ...baseInput, tools: undefined });

    expect(explicitlyUndefined).toBe(omitted);
  });

  it('should differ between a tool-free request and one offering a tool', () => {
    const withoutTools = computeCacheKey(baseInput);
    const withTools = computeCacheKey({ ...baseInput, tools: oneTool });

    expect(withTools).not.toBe(withoutTools);
  });

  it('should differ when the tool input schema shape changes', () => {
    const a = computeCacheKey({ ...baseInput, tools: oneTool });
    const b = computeCacheKey({
      ...baseInput,
      tools: [{ ...oneTool[0], inputSchema: z.object({ id: z.number() }) }],
    });

    expect(a).not.toBe(b);
  });

  it('should produce the same key whether toolChoice is omitted or explicitly undefined', () => {
    const omitted = computeCacheKey(baseInput);
    const explicitlyUndefined = computeCacheKey({ ...baseInput, toolChoice: undefined });

    expect(explicitlyUndefined).toBe(omitted);
  });

  it('should differ between a request with no toolChoice and one forcing "required"', () => {
    const withoutToolChoice = computeCacheKey({ ...baseInput, tools: oneTool });
    const withToolChoice = computeCacheKey({
      ...baseInput,
      tools: oneTool,
      toolChoice: 'required',
    });

    expect(withToolChoice).not.toBe(withoutToolChoice);
  });

  it('should differ between forcing a specific tool and any other toolChoice', () => {
    const required = computeCacheKey({ ...baseInput, tools: oneTool, toolChoice: 'required' });
    const forcedTool = computeCacheKey({
      ...baseInput,
      tools: oneTool,
      toolChoice: { tool: 'lookup' },
    });

    expect(forcedTool).not.toBe(required);
  });

  // Real-corpus proof: `computeCacheKey`'s own output — a lowercase hex sha256 digest — is the
  // filename convention every fixture under `eval/cache/model/` is committed under. A future
  // change to the hash algorithm or its encoding would desync every one of those filenames from
  // what this function actually produces, and this fails loudly on that rather than only on the
  // narrower omit-when-absent cases above.
  it('should produce a digest matching the filename convention of the committed eval replay corpus', () => {
    const fixtureFiles = readdirSync(EVAL_MODEL_CACHE_DIR).filter(
      (file) => file !== 'manifest.json',
    );
    expect(fixtureFiles.length).toBeGreaterThan(0);
    for (const file of fixtureFiles) {
      expect(file).toMatch(/^[0-9a-f]{64}\.json$/);
    }

    expect(computeCacheKey(baseInput)).toMatch(/^[0-9a-f]{64}$/);
  });
});
