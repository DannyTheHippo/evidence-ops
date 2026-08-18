import type { Observable } from 'rxjs';
import { concatMap, filter, map, take, timer } from 'rxjs';
import { StreamConnectionLimitExceededException } from '../exceptions/stream-connection-limit.exception';

/** Identifies the session an open SSE connection was authorized under at subscribe time. */
export interface StreamSession {
  readonly userId: string;
  readonly tenantId: string;
}

/**
 * Emits once and completes the moment a periodic re-read of `session.userId` comes back absent or
 * naming a different tenant than `session.tenantId`. An SSE connection's subscription outlives the
 * request that opened it, so this is the only way a stream learns the browser logged out, the
 * account was removed, or it moved tenants mid-connection — none of which the initial
 * `@CurrentUser()` check at subscribe time can ever see. Meant to be piped into a live stream via
 * `takeUntil`.
 *
 * A `reload` rejection (a transient read failure) is folded into the same "no session" branch
 * rather than left to propagate: this is a permission gate, and a permission gate that cannot
 * resolve the answer fails CLOSED — it ends the stream rather than staying open on a grant it
 * could not just reverify.
 */
export function reauthTicks$(
  session: StreamSession,
  reload: (userId: string) => Promise<{ tenantId: string } | null>,
  intervalMs: number,
): Observable<void> {
  return timer(intervalMs, intervalMs).pipe(
    concatMap(() => reload(session.userId).catch(() => null)),
    filter((current) => current === null || current.tenantId !== session.tenantId),
    take(1),
    map(() => undefined),
  );
}

// Field names match `SseConfig` (`environment.config.ts`) so callers pass `TypedConfigService.sse`
// straight through rather than reshaping it at every call site.
export interface StreamConnectionLimits {
  readonly maxConnectionsPerTenant: number;
  readonly maxConnectionsPerUser: number;
}

// Process-lifetime, not per-request: a multi-process deployment enforces the configured cap once
// per process rather than as one cluster-wide total (`SseConfig`'s doc comment in
// `environment.config.ts` names the same tradeoff).
const openConnectionsByTenant = new Map<string, number>();
const openConnectionsByUser = new Map<string, number>();

function releaseSlot(counts: Map<string, number>, key: string): void {
  // `key` is always present with a count of at least 1: `acquireStreamSlot` sets both counters
  // before it returns the release closure, and that closure's `released` flag blocks a second
  // call. The assertion states that invariant rather than adding an unreachable fallback branch.
  const count = counts.get(key) as number;
  if (count <= 1) {
    counts.delete(key);
  } else {
    counts.set(key, count - 1);
  }
}

/**
 * Reserves one open SSE connection slot for `tenantId`/`userId` against `limits`, throwing
 * `StreamConnectionLimitExceededException` (429) the instant either counter is already at its cap
 * — refusal at connection admission, fail CLOSED, rather than an unbounded accept. Callers MUST
 * invoke the returned release function exactly once when the stream ends (`finalize` in the
 * controller covers complete, error, and client-disconnect unsubscribe alike); the counters are
 * process state, not tied to any one request's lifecycle, so a stream that never releases leaks
 * capacity until the process restarts.
 */
export function acquireStreamSlot(
  tenantId: string,
  userId: string,
  limits: StreamConnectionLimits,
): () => void {
  const tenantCount = openConnectionsByTenant.get(tenantId) ?? 0;
  if (tenantCount >= limits.maxConnectionsPerTenant) {
    throw new StreamConnectionLimitExceededException(
      `Tenant '${tenantId}' is at its open-stream limit (${limits.maxConnectionsPerTenant})`,
    );
  }

  const userCount = openConnectionsByUser.get(userId) ?? 0;
  if (userCount >= limits.maxConnectionsPerUser) {
    throw new StreamConnectionLimitExceededException(
      `User '${userId}' is at its open-stream limit (${limits.maxConnectionsPerUser})`,
    );
  }

  openConnectionsByTenant.set(tenantId, tenantCount + 1);
  openConnectionsByUser.set(userId, userCount + 1);

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseSlot(openConnectionsByTenant, tenantId);
    releaseSlot(openConnectionsByUser, userId);
  };
}
