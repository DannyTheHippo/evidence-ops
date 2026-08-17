/**
 * Not a `BaseException`/`HttpException` — the provider layer runs outside HTTP request scope
 * (Temporal activities, `scripts/`, and eventually an eval runner), so it cannot assume a
 * controller is there to catch it. Callers that do sit behind a controller are responsible for
 * mapping this to an HTTP response themselves.
 *
 * Thrown when `TenantSpendService.reserve` cannot fit a reservation under a tenant's daily spend
 * ceiling. The ceiling fails CLOSED — refusing outright is the only safe response; letting the
 * call proceed and hoping it settles under budget would let a tenant's spend run past the limit
 * it exists to enforce.
 */
export class TenantSpendLimitExceededError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly amountUsd: number,
    public readonly limitUsd: number,
  ) {
    super(
      `Reserving $${amountUsd.toFixed(4)} for tenant '${tenantId}' would exceed the ` +
        `$${limitUsd.toFixed(4)} daily spend ceiling`,
    );
    this.name = 'TenantSpendLimitExceededError';
  }
}
