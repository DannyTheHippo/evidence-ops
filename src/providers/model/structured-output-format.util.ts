import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import { toJSONSchema, type z } from 'zod/v4';

export interface StructuredOutputFormat {
  readonly type: 'json_schema';
  readonly schema: Record<string, unknown>;
}

/**
 * `@anthropic-ai/sdk`'s own `zodOutputFormat()` helper hardcodes `toJSONSchema(schema, { reused:
 * 'ref' })`. Verified against the installed `zod@4.4.3`: with that option, `answerContractSchema`
 * (a `z.discriminatedUnion` whose `answered` branch nests `claimSchema`/`citationSchema` inside an
 * array) emits `claimSchema`/`citationSchema`/etc. into `$defs` with `$ref`s pointing at them —
 * each of those subschemas appears only once in the source, so "reused" here is zod's internal
 * traversal-count bookkeeping, not literal duplication in the schema definition. Anthropic's
 * structured-outputs API rejects `$defs` referenced from inside `anyOf`/`oneOf`, which is exactly
 * the live failure this fixes: `400 output_config.format.schema: For 'anyOf', '$defs' is not
 * supported`. `reused: 'inline'` (zod's own default; `zodOutputFormat` just doesn't use it)
 * expands every subschema at each use site instead of hoisting it, so the emitted schema is fully
 * self-contained with no `$defs`/`$ref` — confirmed empirically for this schema, not assumed.
 * `transformJSONSchema` is the same SDK-internal step `zodOutputFormat` applies afterwards
 * (draft-2020-12 `oneOf` -> `anyOf`, `additionalProperties: false`, unsupported keywords folded
 * into `description`) — reused here so the wire shape stays identical to what the SDK would have
 * produced, minus the `$defs`/`$ref`.
 */
export function toStructuredOutputFormat(schema: z.ZodType): StructuredOutputFormat {
  return {
    type: 'json_schema',
    schema: transformJSONSchema(toJSONSchema(schema, { reused: 'inline' })),
  };
}
