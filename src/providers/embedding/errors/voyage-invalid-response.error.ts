/**
 * Thrown when a 2xx Voyage embeddings response does not match the expected shape. Fails CLOSED:
 * a schema mismatch is always an error, never coerced into a partial or best-effort result — a
 * malformed embedding reaching vector storage silently is a worse failure than a loud one here,
 * at the boundary that produced it.
 */
export class VoyageInvalidResponseError extends Error {
  constructor(public readonly issues: readonly { path: string; message: string }[]) {
    super(
      `Voyage embeddings response failed schema validation: ${issues
        .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'VoyageInvalidResponseError';
  }
}
