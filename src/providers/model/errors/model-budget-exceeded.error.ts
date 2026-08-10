/**
 * Not a `BaseException`/`HttpException` — the provider layer runs outside HTTP request scope
 * (Temporal activities, `scripts/`, and eventually an eval runner), so it cannot assume a
 * controller is there to catch it. Callers that do sit behind a controller are responsible for
 * mapping this to an HTTP response themselves.
 *
 * Thrown when the pre-call worst-case cost estimate exceeds `maxCostUsd`. The budget gate fails
 * CLOSED — refusing outright is the only safe response; silently clamping `maxTokens` down to
 * fit the budget would let a caller believe it got a complete answer when the response may have
 * been cut short.
 */
export class ModelBudgetExceededError extends Error {
  constructor(
    public readonly estimatedCostUsd: number,
    public readonly maxCostUsd: number,
  ) {
    super(
      `Estimated worst-case cost $${estimatedCostUsd.toFixed(4)} exceeds the $${maxCostUsd.toFixed(4)} budget cap`,
    );
    this.name = 'ModelBudgetExceededError';
  }
}
