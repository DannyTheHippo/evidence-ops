export interface ModelValidationIssue {
  /**
   * Stringified at the boundary. zod types issue paths as `PropertyKey[]`, which admits symbols —
   * and `Array.prototype.join` throws on a symbol element. This path is only ever rendered into a
   * message, so normalising to strings removes the hazard rather than propagating it.
   */
  readonly path: readonly string[];
  readonly message: string;
}

/**
 * Thrown after the single schema-validation retry also fails (see `AnthropicModelProvider`).
 * Carries the issues from the final attempt so the caller can see exactly what shape the model
 * kept getting wrong, rather than a generic "invalid output" message.
 */
export class ModelSchemaValidationError extends Error {
  constructor(
    public readonly issues: readonly ModelValidationIssue[],
    public readonly raw: string,
  ) {
    super(
      `Model output failed schema validation after one retry: ${issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'ModelSchemaValidationError';
  }
}
