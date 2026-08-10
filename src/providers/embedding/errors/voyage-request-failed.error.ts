/** Thrown on a non-2xx response from the Voyage embeddings endpoint. */
export class VoyageRequestFailedError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Voyage embeddings request failed with status ${status}: ${body}`);
    this.name = 'VoyageRequestFailedError';
  }
}
