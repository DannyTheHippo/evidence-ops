import { z } from 'zod/v4';
import { toStructuredOutputFormat } from '../../../src/providers/model/structured-output-format.util';

describe('toStructuredOutputFormat', () => {
  it('should set type "json_schema"', () => {
    const format = toStructuredOutputFormat(z.object({ answer: z.string() }));

    expect(format.type).toBe('json_schema');
  });

  it('should emit no $defs or $ref for a discriminated union that reuses a branch-nested schema', () => {
    // Mirrors the shape of `answerContractSchema`: a discriminated union where one branch
    // contains an array of an object schema referenced only once in the tree. Zod's `reused:
    // 'ref'` mode (what `@anthropic-ai/sdk`'s own `zodOutputFormat()` hardcodes) still hoists
    // this into `$defs`, which Anthropic's structured-outputs API rejects under `anyOf`.
    const item = z.object({ value: z.string() });
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), items: z.array(item) }),
      z.object({ kind: z.literal('b'), reason: z.string() }),
    ]);

    const format = toStructuredOutputFormat(union);
    const serialized = JSON.stringify(format.schema);

    expect(serialized).not.toContain('$defs');
    expect(serialized).not.toContain('$ref');
  });

  it('should convert the discriminated union to anyOf, matching what the live API expects', () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), value: z.string() }),
      z.object({ kind: z.literal('b'), value: z.number() }),
    ]);

    const format = toStructuredOutputFormat(union);

    expect(Array.isArray(format.schema['anyOf'])).toBe(true);
  });

  it('should set additionalProperties false on object branches, matching the SDK strict transform', () => {
    const format = toStructuredOutputFormat(z.object({ answer: z.string() }));

    expect(format.schema['additionalProperties']).toBe(false);
  });
});
