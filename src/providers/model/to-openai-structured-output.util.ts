import { toJSONSchema, type z } from 'zod/v4';

export interface OpenAiStructuredOutputFormat {
  readonly type: 'json_schema';
  readonly json_schema: {
    readonly name: string;
    readonly strict: true;
    readonly schema: Record<string, unknown>;
  };
  /** True when the root schema was a union and got wrapped under a `result` property. When true,
   * the caller must read `parsed.result` rather than `parsed` after parsing the model's JSON
   * response. */
  readonly wrapped: boolean;
}

/** Exported for `OpenAiModelProvider`'s tool-parameter conversion, which reuses the same
 * `toJSONSchema` call this function makes but needs the bare parameter schema, not the
 * root-wrapping this function applies for OpenAI's structured-outputs strict-mode root
 * requirement. */
export function withoutSchemaKeyword(schema: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}

/**
 * OpenAI's structured-outputs strict mode rejects a union at the schema root. Verified against
 * `toJSONSchema(schema, { reused: 'inline' })`'s actual output for a `z.discriminatedUnion`
 * (`answer.contract.ts`'s `modelAnswerContractSchema`): the root comes back as `{ oneOf: [...] }`
 * with no `type`/`properties`/`required` for OpenAI's strict validator to walk — the same problem
 * class OpenAI's own docs describe as "root objects must not be anyOf". Wrapping the union under a
 * single `result` property gives OpenAI a valid `type: 'object'` root; `wrapped` on the return
 * value tells the caller whether it needs to unwrap `parsed.result` afterwards.
 *
 * Every object zod emits already carries `additionalProperties: false` and lists every one of its
 * own properties in `required` — the strict-mode invariants OpenAI demands throughout the schema
 * — so this function does no separate pass to enforce them. `factExtractionResultSchema` and
 * `modelAnswerContractSchema` (the two contracts this is built for) have no optional fields, so
 * there is nothing here to convert to a nullable-plus-required workaround; a schema that does
 * introduce an optional field would need that additional transform, which this function does not
 * yet perform.
 */
export function toOpenAiStructuredOutputFormat(
  schema: z.ZodType,
  name: string,
): OpenAiStructuredOutputFormat {
  const rootSchema = withoutSchemaKeyword(toJSONSchema(schema, { reused: 'inline' }));
  const isUnionRoot = 'oneOf' in rootSchema || 'anyOf' in rootSchema;

  const outputSchema = isUnionRoot
    ? {
        type: 'object',
        properties: { result: rootSchema },
        required: ['result'],
        additionalProperties: false,
      }
    : rootSchema;

  return {
    type: 'json_schema',
    json_schema: { name, strict: true, schema: outputSchema },
    wrapped: isUnionRoot,
  };
}
