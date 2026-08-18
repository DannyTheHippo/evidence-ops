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
 * request that opened it, so this is the only way a stream detects the user row being deleted or
 * moved to a different tenant mid-connection — none of which the initial `@CurrentUser()` check at
 * subscribe time can ever see. It does not detect a browser logout: `AuthService.logout` writes an
 * audit row and revokes nothing, so a stream opened before a logout stays open until this tick's own
 * termination conditions fire, same as any other still-valid session. Meant to be piped into a live
 * stream via `takeUntil`.
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
  // `key` is always present with a count of at least 1 in practice: `acquireStreamSlot` sets both
  // counters before it returns the release closure, and that closure's `released` flag blocks a
  // second call. `?? 0` guards that invariant rather than trusting it with an unchecked cast — if
  // it ever broke, a bare cast would send a missing entry down the decrement branch below
  // (`undefined <= 1` is `false`) and write `NaN` over the counter, silently disabling the cap for
  // that key; reading a missing entry as already-zero instead deletes it, a safe no-op.
  const count = counts.get(key) ?? 0;
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

// Per-process, keyed by an actor+subject pair. Evicted the same way `McpServerService
// .applyFixedWindow` evicts its rate-limit windows — a full sweep on every call — so this stays
// bounded to keys seen within the last `windowMs`, not to every actor+subject pair the process has
// ever recorded a view for.
const lastRecordedStreamViews = new Map<string, number>();

/**
 * Gates a stream's opening audit write so a reconnecting client's repeated opens against the same
 * subject collapse to one recorded row per `windowMs` rather than one per open — an SSE stream
 * that drops and reopens on every network blip would otherwise flood the audit log with rows that
 * say nothing new. `true` the first time `key` is seen, or once `windowMs` has fully elapsed since
 * the last `true` for that key; `false` while still inside the window. Meant to wrap the audit
 * write in `QaService.streamAnswer`'s and `WorkflowRunsService.streamRun`'s `opened$` pipes, keyed
 * on `actorId` plus the subject id so two different callers viewing the same subject are still
 * each recorded.
 */
export function shouldRecordStreamView(key: string, windowMs: number): boolean {
  const now = Date.now();
  for (const [entryKey, recordedAt] of lastRecordedStreamViews) {
    if (now - recordedAt >= windowMs) {
      lastRecordedStreamViews.delete(entryKey);
    }
  }

  if (lastRecordedStreamViews.has(key)) {
    return false;
  }

  lastRecordedStreamViews.set(key, now);
  return true;
}
