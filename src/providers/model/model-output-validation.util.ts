import type { z } from 'zod/v4';
import type { ModelValidationIssue } from './errors/model-schema-validation.error';

/**
 * Rough chars-per-token heuristic (~4 chars/token for English) used only to pre-flight the
 * budget check before a call is made. Never used for billing — actual cost always comes from
 * the vendor's real `usage` counters after the call.
 */
const ESTIMATED_CHARS_PER_TOKEN = 4;

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

export function formatIssuesForRetry(issues: readonly ModelValidationIssue[]): string {
  return issues
    .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

export type SafeParseModelJsonResult<TSchema extends z.ZodType> =
  { success: true; data: z.infer<TSchema> } | { success: false; issues: ModelValidationIssue[] };

/**
 * Parses a model's raw text response as JSON and validates it against `schema`, never throwing —
 * a malformed or off-schema response is an expected outcome the caller retries on, not an
 * exceptional one.
 */
export function safeParseModelJson<TSchema extends z.ZodType>(
  text: string,
  schema: TSchema,
): SafeParseModelJsonResult<TSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      issues: [{ path: [], message: `Response is not valid JSON: ${message}` }],
    };
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String),
      message: issue.message,
    })),
  };
}
