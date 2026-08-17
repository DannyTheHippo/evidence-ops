import { z } from 'zod/v4';
import { modelAnswerContractSchema } from '../../../src/features/evidence/qa/contracts/answer.contract';
import { factExtractionResultSchema } from '../../../src/features/evidence/facts/contracts/fact-extraction.contract';
import { toOpenAiStructuredOutputFormat } from '../../../src/providers/model/to-openai-structured-output.util';

/** Recursively asserts the two strict-mode invariants OpenAI requires throughout a schema: every
 * property in `properties` is also listed in `required`, and every object carries
 * `additionalProperties: false`. */
function assertStrictModeInvariants(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(assertStrictModeInvariants);
    return;
  }
  if (typeof node !== 'object' || node === null) {
    return;
  }

  const schema = node as Record<string, unknown>;
  if (schema.type === 'object' && schema.properties) {
    const propertyNames = Object.keys(schema.properties);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(propertyNames));
    expect((schema.required as unknown[]).length).toBe(propertyNames.length);
  }

  Object.values(schema).forEach(assertStrictModeInvariants);
}

describe('toOpenAiStructuredOutputFormat', () => {
  it('should set type "json_schema" and strict true', () => {
    const format = toOpenAiStructuredOutputFormat(z.object({ answer: z.string() }), 'plain');

    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.name).toBe('plain');
  });

  it('should wrap the union-rooted answer contract under a "result" property', () => {
    // `modelAnswerContractSchema` is a `z.discriminatedUnion` — its root JSON Schema comes back
    // as `{ oneOf: [...] }` with no `type`/`properties`, which OpenAI's strict-mode root rejects.
    const format = toOpenAiStructuredOutputFormat(modelAnswerContractSchema, 'answer');

    expect(format.wrapped).toBe(true);
    expect(format.json_schema.schema.type).toBe('object');
    const properties = format.json_schema.schema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(['result']);
    expect(format.json_schema.schema.required).toEqual(['result']);
    expect(properties.result).toHaveProperty('oneOf');
  });

  it('should NOT wrap the plain-object-rooted fact-extraction contract', () => {
    // `factExtractionResultSchema` is a plain `z.object` — its root is already `type: 'object'`,
    // so no wrapping is needed for OpenAI's strict-mode root requirement.
    const format = toOpenAiStructuredOutputFormat(factExtractionResultSchema, 'fact_extraction');

    expect(format.wrapped).toBe(false);
    expect(format.json_schema.schema.type).toBe('object');
    expect(format.json_schema.schema).not.toHaveProperty('oneOf');
    expect(format.json_schema.schema).not.toHaveProperty('result');
  });

  it('should hold the strict-mode invariants throughout the answer contract schema', () => {
    const format = toOpenAiStructuredOutputFormat(modelAnswerContractSchema, 'answer');

    assertStrictModeInvariants(format.json_schema.schema);
  });

  it('should hold the strict-mode invariants throughout the fact-extraction contract schema', () => {
    const format = toOpenAiStructuredOutputFormat(factExtractionResultSchema, 'fact_extraction');

    assertStrictModeInvariants(format.json_schema.schema);
  });

  it('should strip the $schema meta-keyword from the emitted schema', () => {
    const format = toOpenAiStructuredOutputFormat(z.object({ answer: z.string() }), 'plain');

    expect(format.json_schema.schema).not.toHaveProperty('$schema');
  });
});
