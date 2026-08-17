/**
 * Not a `BaseException`/`HttpException` — see `OpenAiRequestFailedError` for why.
 *
 * Thrown when a 2xx chat/completions response does not match the expected envelope shape. Fails
 * CLOSED: a malformed response is always an error here, never coerced into a partial result — this
 * is a different failure class from `ModelSchemaValidationError`, which validates the *model's own
 * JSON output* against the caller's schema, not the transport envelope carrying it.
 */
export class OpenAiInvalidResponseError extends Error {
  constructor(public readonly issues: readonly { path: string; message: string }[]) {
    super(
      `OpenAI chat completion response failed schema validation: ${issues
        .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'OpenAiInvalidResponseError';
  }
}
