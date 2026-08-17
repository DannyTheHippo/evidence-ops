/**
 * Not a `BaseException`/`HttpException` — the provider layer runs outside HTTP request scope
 * (Temporal activities, `scripts/`, and eventually an eval runner), so it cannot assume a
 * controller is there to catch it. Callers that do sit behind a controller are responsible for
 * mapping this to an HTTP response themselves.
 *
 * Thrown by `SpendGuardModelProvider` when a request carries no `tenantId` while the daily spend
 * ceiling is enabled. Fails CLOSED — a spend ceiling protects an irreversible action (money
 * leaving the account), so a call that cannot be attributed to a tenant must not proceed rather
 * than being reserved against an unrelated tenant or let through unmetered.
 */
export class ModelRequestMissingTenantError extends Error {
  constructor(public readonly taskClass: string) {
    super(`Model request for task class '${taskClass}' has no tenantId to attribute spend to`);
    this.name = 'ModelRequestMissingTenantError';
  }
}
