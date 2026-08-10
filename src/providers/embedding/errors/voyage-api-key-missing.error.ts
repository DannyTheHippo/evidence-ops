/**
 * Fails CLOSED — an embedding call with no key would otherwise reach Voyage and fail there
 * with a less specific 401; failing before the network round-trip gives callers (and the
 * smoke script) a message that names the actual missing config.
 */
export class VoyageApiKeyMissingError extends Error {
  constructor() {
    super('VOYAGE_API_KEY is not configured');
    this.name = 'VoyageApiKeyMissingError';
  }
}
