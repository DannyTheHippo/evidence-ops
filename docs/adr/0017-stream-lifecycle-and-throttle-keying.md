# ADR-0017 — Stream lifecycle and throttle keying: re-authorize, cap, dedupe, and stop guessing the page

- **Status:** Accepted
- **Date:** 2026-08-18
- **Supersedes:** —

## Context

An audit of the three SSE streams (`QaService.streamAnswer`, `WorkflowRunsService.streamRun`,
`DocumentsService.streamList`) and the global throttler found four related defects, none of them
hypothetical:

1. **Throttling collapsed to one deployment-wide bucket.** `app.set('trust proxy', …)` was never
   called, so behind `web/nginx.conf` every request arrived at Express carrying the proxy
   container's own address, not the browser's. `ThrottlerGuard`'s default IP-keyed tracker then
   keyed every request the same way regardless of who sent it — one user could exhaust the shared
   budget and 429 the whole product for every other tenant.
2. **SSE streams authorized once, at subscribe, and never again.** A logout, a revoked session, or
   an account moved to a different tenant did nothing to a connection already open — it kept
   streaming under a grant that no longer held. Nothing capped how many connections one tenant or
   one user could hold open at once, and `streamList` had no terminal condition of any kind — the
   other two streams end when the answer/run they follow reaches a terminal status, but a document
   list has no terminal state of its own, so a client that never disconnected held its slot forever.
3. **One audit row per stream *open*, not per viewing session.** `streamAnswer` and `streamRun`
   both wrote `qa.answer.viewed`/`workflow-runs.viewed` on every subscribe, gated only on the
   subject existing. A reconnecting client — a laptop waking from sleep, a flaky network blip, a
   browser tab regaining focus — reopens the connection on every blip, and each reopen wrote a row
   that said nothing a human reviewing the audit log hadn't already been told.
4. **Two "pinned page" divergences, wrongly assumed to be the same bug.** `DocumentsService
   .streamList` hardcoded `DEFAULT_PAGINATION_SKIP`/`DEFAULT_PAGINATION_LIMIT`, so a tenant with
   more than 20 documents saw the stream disagree with `GET /documents?skip=20` the moment they
   paged past page 1 — the SPA's `DocumentList.tsx` had already worked around this by disabling the
   stream past page 1 entirely (`url: skip === 0 ? documentEventsUrl() : null`), which only hid the
   divergence rather than closing it. `WorkflowRunsService.streamRun`'s `approvals` sub-stream
   shipped the tenant's *entire* pending-approval inbox on every tick, unfiltered by which run the
   caller actually named — a different shape of the same "the stream shows more or less than the
   page the caller asked for" family, but not fixable by adding `skip`/`limit`: an inbox has no page
   of its own to disagree with the poll about, and a run's own blocking approval could sit at
   position #21 in a paged inbox and never appear regardless of page size.

## Decision

### Throttle keyed by verified identity, and subclassing alone does not get you there

`UserThrottlerGuard extends ThrottlerGuard`, overriding `getTracker` to return `user:${userId}`
when `request.user` is set, `ip:${ip}` when it isn't (login, registration — routes reached before
authentication), and a single fixed `'unresolved'` key when neither resolves. That third branch is
the fail-closed choice: an unresolvable request is throttled together with every other unresolvable
request, never exempted by a unique or empty tracker. `app.set('trust proxy', 1)` is pinned to the
compose topology's one real hop (`web/nginx.conf`'s single `proxy_pass http://api:3000`) — without
it, `request.ip` is nginx's own address regardless of what the guard keys on.

Registering the guard is not simply swapping the `APP_GUARD` provider. NestJS registers global
guards in module-scan order, and a module's own directly-declared providers scan *before* any of
its imports do — so a guard declared directly on `AppModule` always runs before one declared on an
imported module, whatever the import array's own order says. `JwtAuthGuard` (which stamps
`request.user`) is declared on `AuthModule`; a naive `{ provide: APP_GUARD, useClass:
UserThrottlerGuard }` directly on `AppModule.providers` would therefore run *before* `JwtAuthGuard`
on every request, see `request.user === undefined`, and key every authenticated request by IP
anyway — the exact bucket-collapse this change exists to fix, silently reintroduced. The fix is a
one-provider `ThrottlingModule`, imported into `AppModule` after `AuthModule`, so the scanner visits
it — and registers its guard — second. **A unit test on `getTracker` cannot catch the ordering bug
at all**: `getTracker` returns distinct strings for distinct inputs regardless of when it runs, so a
green unit spec is compatible with the guard never actually seeing `request.user`. Only an
end-to-end request — two authenticated users, asserting neither 429s the other — proves the bucket
actually split; that e2e is what caught this ordering bug the first time and is what stays as the
regression guard.

### SSE re-authorizes on a timer and caps admission before it re-authorizes anything

`src/shared/utils/stream-session.util.ts` gained two independent mechanisms, both process-lifetime
rather than tied to any one request:

- **`reauthTicks$`** re-reads the connecting user every `SSE_REAUTH_INTERVAL_MS` (30s) and emits
  once, ending the stream, the moment the reload comes back absent or names a different tenant than
  the one the connection opened under. A reload rejection (a transient read failure) folds into the
  same "session gone" branch rather than propagating — this is a permission gate, and a permission
  gate that cannot resolve the answer fails CLOSED, ending the stream rather than trusting a grant
  it could not just reverify. All three streams pipe this into `takeUntil`.
- **`acquireStreamSlot`** reserves one open-connection slot against `TypedConfigService.sse`'s
  `maxConnectionsPerTenant`/`maxConnectionsPerUser` caps, throwing
  `StreamConnectionLimitExceededException` (429, `BaseException`-derived so the detail survives
  `GlobalExceptionFilter`) the instant either counter is already at its cap — refusal at admission,
  fail CLOSED, rather than an unbounded accept. Each of the three controllers acquires a slot before
  subscribing and releases it via `finalize()`, which covers `complete`, `error`, and a client
  disconnect alike.

`streamList` — the one stream with no terminal status of its own to close on — additionally gained
a bare `takeUntil(timer(config.sse.maxStreamLifetimeMs))` (30 minutes), so a client that never
disconnects still loses its slot eventually rather than holding it for the life of the process.

### Audit rows collapse to one per stream session, with an explicit exception

`shouldRecordStreamView` (`stream-session.util.ts:120`) gates the opening audit write in
`streamAnswer`'s and `streamRun`'s `opened$` pipes: `true` the first time a key is seen, or once
`SSE_STREAM_VIEW_AUDIT_DEDUPE_WINDOW_MS` (5 minutes) has fully elapsed since the last `true` for
that key, `false` otherwise. The key is `action:actorId:subjectId`, so two different callers
viewing the same subject are still each recorded — the dedupe collapses *repeat opens by the same
viewer*, not distinct viewers. Eviction mirrors `McpServerService.applyFixedWindow`'s existing
fixed-window sweep rather than introducing a second cleanup strategy: every call sweeps expired
entries from the shared `Map` before checking the key, so the map stays bounded to keys seen within
the last window rather than growing for the life of the process.

`documents/events` writes no audit row at all, before or after this change, and that is a
deliberate omission carried forward rather than an oversight: `DocumentsService.list` (which
`streamList` polls) was never an audited read to begin with — matching `list()`'s own "browsing
your own list is not an audited action" precedent — so there was never a per-open row to flood the
log with, and adding one now would audit a read that has never been audited anywhere else in this
codebase.

### The two "pinned page" divergences get different fixes, because they are different bugs

**`DocumentsService.streamList`** (`documents.service.ts:299`) now takes a `PaginationRequestDto`
and threads it straight into `list()`, replacing the hardcoded `DEFAULT_PAGINATION_SKIP`/
`DEFAULT_PAGINATION_LIMIT`. `DocumentsController.streamEvents` reads `skip`/`limit` off the same
`@Query() pagination: PaginationRequestDto` the polled `GET /documents` route already uses, so a
request for page 2 of the stream and page 2 of the poll are, structurally, the same query. This is
correct specifically *because* the stream mirrors a list the caller is paging through — `list`'s own
`sort: {createdAt: -1}` means "page 2" has a real, stable meaning that stream and poll must agree
on, and a hardcoded window can never agree with a caller-chosen one.

**`WorkflowRunsService.streamRun`**'s approvals sub-stream does **not** get pagination — the run
page never pages approvals, so there is no caller-chosen page to agree with. Its actual divergence
was that the run's own blocking approval could be entry #21 in the tenant-wide inbox and fall
outside any fixed-size peek regardless of page size; paging would not have touched that. Instead,
`ApprovalsService.peekPending` gained an optional third parameter, `workflowId` — when given, it
narrows the filter to approvals requested by that one workflow. `streamRun` resolves the run once
(via a lazily-memoized `getInitialRun` closure shared between the opening audit gate and the
approvals sub-stream — a plain `Promise`, not a multicast RxJS operator, since `concat(opened$,
merge(...))` already sequences `opened$` to resolve first) and passes its `workflowId` through on
every tick. **This closes the pagination divergence and the wider exposure in the same move**: the
"deliberately deferred" finding that `streamRun` shipped the whole tenant's pending-approval inbox
to anyone naming any run id (`workflow-runs.service.ts:201-217` before this change) is the same
code path — scoping the query to the run's own approval is simultaneously the correct fix for "this
run's approval might not be in the peek window" and the correct fix for "this stream reveals every
other pending approval in the tenant." **The scoping was feasible and is shipped**, not deferred:
`Approval.workflowId` already existed and needed no new index for this filter's cardinality. A run
whose `workflowId` cannot be resolved — a pre-D3 row minted before that field was threaded through,
per `ApprovalsService.decide`'s own note on the same edge case — falls back to the unscoped inbox,
since there is no better key to filter by for that one legacy shape; this is a narrower residual
than the exposure being closed, not a reopening of it.

### The SPA workaround is removed, not left to coexist with the fix

`DocumentList.tsx`'s `url: skip === 0 ? documentEventsUrl() : null` was a stopgap the frontend cycle
added specifically because the stream was hardcoded to the newest 20 — with the stream now pageable,
that condition is always true from the stream's own point of view, so the SPA's `documentEventsUrl`
gained the same `{skip, limit}` parameters `listDocuments` already takes, and the page-1-only guard
was deleted outright. `useEventStream`'s connection effect is already keyed on `[options.url]`, so a
page change now closes the old `EventSource` and opens a fresh one scoped to the new page — no new
mechanism, the existing reconnect-on-URL-change behavior just applies to the case it previously
couldn't reach.

## Known bounds

1. **Every cap and dedupe window here is per-process, not cluster-wide.** `acquireStreamSlot`'s
   connection counters and `shouldRecordStreamView`'s dedupe map are both plain in-memory `Map`s
   with no shared store — correct for this pilot's single-replica deployment, and each doc comment
   says so, but a horizontal scale-out would need a shared counter (Redis or equivalent) before
   these caps mean what their names claim across more than one process.
2. **`web/nginx.conf`'s `proxy_read_timeout 300s` still exceeds the 15s heartbeat interval by 20x.**
   A wedged upstream still holds a socket for up to five minutes, and nothing yet bounds concurrent
   upstream sockets at the proxy layer. The per-tenant/per-user caps in this ADR bound the common
   case at the application layer; the proxy-level tuning is left until there is real traffic to size
   it against, not resolved by this change.
3. **The dedupe window trades false negatives for false positives in one direction only.** A caller
   who closes and reopens a stream to genuinely re-view a subject inside the 5-minute window
   produces no second audit row — the same tradeoff `McpServerService`'s rate limiter makes with its
   own fixed window, accepted here because the alternative (flooding) is the defect this ADR exists
   to close, and a human reviewing the audit log for "was this subject viewed" gets one true answer,
   not a miscount by absence.

## Consequences

**Good.** A user behind the shared nginx proxy can no longer exhaust another tenant's throttle
budget, provably by e2e rather than by a unit test that cannot see the module-scan-order bug at all.
Every SSE stream now ends within a bounded time of a session actually becoming invalid, and no
single tenant or user can hold an unbounded number of connections open. The audit log records one
row per genuine viewing session instead of one per reconnect, so a reviewer's read of "who looked at
this" stays meaningful under network conditions that used to flood it. A tenant with more than 20
documents sees the stream and the poll agree on every page, not only the first, and the SPA
workaround that used to paper over the disagreement is gone rather than left dead in the tree. The
run-scoped approvals fix closes a real exposure — naming any run id no longer reveals the tenant's
whole pending-approval inbox — as a side effect of fixing the thing that was actually broken, not as
a separate change bolted on afterward.

**Costs.** Three more configuration values to keep coherent (`SSE_MAX_CONNECTIONS_PER_TENANT/USER`,
`SSE_MAX_STREAM_LIFETIME_MS`, plus the fixed, non-configurable
`SSE_STREAM_VIEW_AUDIT_DEDUPE_WINDOW_MS`), each a real caveat a reader of the audit log or a
capacity plan needs to know without reading source. `WorkflowRunsService.streamRun` now resolves
its run row before the approvals sub-stream can tick at all, adding one round-trip of latency to the
very first `approvals` frame — negligible against the stream's own 1.5s tick interval, but real.

**Deferred, deliberately.** Cluster-wide caps and dedupe (Known bounds §1) and the nginx
`proxy_read_timeout`/heartbeat mismatch (Known bounds §2) are both left for when there is production
traffic to size either against — building either now would be tuning against a load pattern that
does not exist yet.

## Interview framing

> The throttle fix isn't really about the tracker — `getTracker` keying on `user.id` instead of IP
> is the easy half. The half worth defending is that a green `getTracker` unit test proves nothing
> about whether the guard ever sees a user at all, because NestJS scans a module's own providers
> before its imports, so a guard declared directly on `AppModule` runs before `AuthModule`'s
> `JwtAuthGuard` regardless of what the tracker itself returns. Only an end-to-end request — two
> real users, asserting neither throttles the other — can catch that, and it's the one that did.
> Second: the two "pinned page" bugs looked identical from the outside — a stream disagreeing with a
> poll — and I'd flag that they needed opposite fixes. `documents/events` needed real pagination
> because it mirrors a page the caller chose. `workflow-runs`'s approvals stream needed the opposite
> — narrower scoping, not a bigger page — because paging an inbox the caller was never meant to see
> the whole of in the first place would have made the exposure worse, not fixed the divergence.

## Related

- `docs/adr/0009-durable-human-approval-gates.md` — the approval model `WorkflowRunsService
  .streamRun`'s now-scoped `approvals` sub-stream surfaces.
- `docs/adr/0014-mcp-server-surface.md` — `McpServerService.applyFixedWindow`, whose sweep-then-check
  shape `shouldRecordStreamView` and `acquireStreamSlot`'s process-lifetime `Map`s follow.
- `docs/global/threat-model.md` — does not yet name the SSE surface or the `retrieval` module by
  name; closing that gap is the docs sweep's job, not this ADR's.
