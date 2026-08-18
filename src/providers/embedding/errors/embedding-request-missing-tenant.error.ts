/**
 * Not a `BaseException`/`HttpException` — the provider layer runs outside HTTP request scope
 * (Temporal activities, `scripts/`, and eventually an eval runner), so it cannot assume a
 * controller is there to catch it. Callers that do sit behind a controller are responsible for
 * mapping this to an HTTP response themselves.
 *
 * Thrown by `SpendGuardEmbeddingProvider` when no tenant is in scope on `AsyncLocalStorage` while
 * the daily spend ceiling is enabled — `EmbeddingRequest` carries no tenant field of its own, so
 * this is the only signal the guard has. Fails CLOSED — a spend ceiling protects an irreversible
 * action (money leaving the account), so a call that cannot be attributed to a tenant must not
 * proceed rather than being reserved against an unrelated tenant or let through unmetered.
 */
export class EmbeddingRequestMissingTenantError extends Error {
  constructor(public readonly inputType: string) {
    super(`Embedding request of type '${inputType}' has no tenant in scope to attribute spend to`);
    this.name = 'EmbeddingRequestMissingTenantError';
  }
}
