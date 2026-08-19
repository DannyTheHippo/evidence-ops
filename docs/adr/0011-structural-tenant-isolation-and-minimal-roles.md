# ADR-0011 — Structural tenant isolation and minimal roles: a backstop, not a replacement

- **Status:** Accepted
- **Date:** 2026-08-12
- **Supersedes:** —

## Context

`docs/global/threat-model.md` §5 named this gap plainly before it was closed: `QaService.getAnswerById`
and `DocumentsService.getById` read by id with no owner and no tenant predicate, and
`DEFAULT_TENANT_ID` was a compile-time constant every write path shared. Any authenticated user who
guessed or enumerated an id could read another tenant's evidence. "RBAC" did not exist at all —
`ToolExecutorService` was the only authorization artifact in the codebase, and it had no caller.

This milestone closes both gaps, deliberately narrowly. `User.tenantId`/`User.role`
(`migrations/0010-user-tenancy-and-roles.ts`) carry a real per-user tenant and one of two roles
into the JWT (`JwtPayload.tenantId`/`role`). Every tenant-scoped service method already threaded an
explicit `tenantId` parameter through its Mongoose queries — that discipline predates this
milestone and stays the primary control. What's new is a second, independent mechanism layered on
top of it, and one admin-gated endpoint.

## Decision

### A hybrid mechanism: explicit parameters stay primary, a global plugin is the backstop

`tenantScopePlugin` (`src/database/plugins/tenant-scope.plugin.ts`) is a global Mongoose connection
plugin, registered once in `src/config/mongo.config.ts` alongside `auditablePlugin`, applied to
every schema that declares a `tenantId` path. It reads the current tenant from AsyncLocalStorage
(populated by `JwtAuthGuard` per request) and intersects it into every scoped query's filter.

Neither the plugin alone nor the explicit parameters alone would have been sufficient, and the
reasons are different for each:

- **The plugin cannot see outside a request.** The Temporal worker, the eval harness, migrations,
  and seed scripts all run with no ALS store — there is no request to read a tenant from. A
  mechanism that only exists inside `AsyncLocalStorage` structurally cannot cover code that never
  enters that store. Those paths must set `tenantId` themselves, explicitly, or they run with no
  tenant at all.
- **Explicit parameters alone are per-call-site discipline that one forgotten query defeats.**
  `DocumentsService.getById` and `QaService.getAnswerById` both scope with
  `findOne({ _id: id, tenantId })` rather than `findById(id)` — that pattern has to be applied
  correctly at every read site, by every author, forever. A single service method written as
  `findById(id)` instead — no compile error, no lint failure, a plausible-looking diff — reopens
  exactly the id-guessing leak this milestone exists to close, and nothing catches it except a
  human reviewing that one method.

The plugin exists to catch the query someone forgot to scope, not to replace scoping. That is why
it does not change any service signature: `getById`, `getAnswerById`, and every other
tenant-scoped method keep taking `tenantId` as a parameter and keep filtering on it explicitly. The
plugin's intersection is redundant with a correctly-written query and load-bearing against an
incorrectly-written one.

### Every failure direction, and why each one is deliberate

**`JwtAuthGuard` fails CLOSED on a missing `tenantId`/`role` claim.**
(`src/features/common/auth/guards/jwt-auth.guard.ts`) A token signed before this deploy can still
verify successfully — the signature is still valid — while carrying the old two-claim shape
(`sub`, `email` only). `JWT_EXPIRES_IN` is 7 days with no refresh or revocation, so such a token
stays structurally valid for up to a week after this ships. The guard checks `!payload.tenantId ||
!payload.role` and rejects rather than defaulting a missing claim to `DEFAULT_TENANT_ID`/`Member`.
The cost is one forced re-login per pre-migration session inside that week; the alternative —
silently defaulting a security-relevant claim — is how isolation bugs get born, not how they get
prevented.

**The plugin fails CLOSED in-request by intersecting, never overwriting.**
`this.setQuery({ $and: [this.getFilter(), { tenantId }] })`, not `filter.tenantId = tenantId`.
Assignment would silently replace a caller's own predicate — corrupting an `$or`/`$in` filter, or
letting a filter that names a foreign tenant simply win over the ALS value. Intersection means a
contradictory explicit predicate (a bug elsewhere naming the wrong tenant) yields the empty set
instead of a wrong-tenant result: the failure mode becomes "returns nothing" rather than "returns
someone else's data."

**The plugin fails OPEN outside a request context — a deliberate no-op, not a gap.** When
`als.getStore()?.tenant` is undefined, the pre-hooks do nothing and the query runs unmodified. This
is not the plugin declining to protect something; it is the plugin recognizing it has no tenant to
enforce and getting out of the way. The worker, the eval harness, and migrations legitimately have
no tenant in scope and pass one explicitly (three verified `insertMany` call sites — see below). A
fail-closed default here — refusing every query with no ALS tenant — would break all three paths
outright, on every run, not just a misconfigured one.

**`RolesGuard` fails CLOSED on missing user, missing role, or an unrecognized role value.**
(`src/features/common/auth/guards/roles.guard.ts`) The check is explicit membership —
`!role || !requiredRoles.includes(role)` — never a negated mismatch check, so a malformed or
unexpected truthy role value cannot slip past. The guard is opt-in (absent `@RequireRole` metadata
means the route doesn't use roles at all, not "deny"), and it is mounted route-scoped rather than
as a third global `APP_GUARD`: Nest already runs global guards before route-scoped ones, so
`request.user` is populated by the time this guard reads it, and a global registration would add
cross-module ordering coupling to gate one endpoint.

**`MongoApprovalChannel.getDecision` fails CLOSED to `rejected` for a cross-tenant id.**
(`src/providers/approval-channel/mongo-approval.channel.ts`) `approvalModel.findOne({ _id:
approvalId, tenantId: tenantId ?? DEFAULT_TENANT_ID })` returns `null` for an id that exists but
under a different tenant, and a `null` result falls into the same "no approval record found"
branch as a genuinely unknown id — collapsing to `rejected` rather than leaking another tenant's
decision. This keeps ADR-0009's original fail-closed contract (`state !== 'approved'`, never a
truthiness check) intact for the mismatch case specifically, without changing the method's
signature or its known bound (ADR-0009 §Known bounds 2) that this scoping is real only because a
caller supplies it — `ApprovalsService.decide()` still scopes its own read before ever calling
`getDecision`.

### The honest can't-intercept list

`tenantScopePlugin`'s own doc comment is the primary source for this; it is repeated here because
an ADR is where a reader looks for the boundary of a control, not just its existence.

- **`aggregate()` is not hooked.** `$search`/`$vectorSearch`/`$rankFusion` must be the first stage
  of a pipeline — a plugin-prepended `$match` would break hybrid retrieval outright. The control on
  that path is `MongoHybridRetrievalStore.extractTenantId` (`src/providers/retrieval/mongo-hybrid.
  store.ts`), which throws on a missing `filter.tenantId` rather than defaulting, so a caller who
  forgets to pass a tenant filter gets a hard error, not a cross-tenant result.
- **Driver-level access bypasses Mongoose entirely.** The GridFS bucket in
  `src/providers/storage/gridfs-document.store.ts` is constructed directly against
  `connection.db` via `mongo.GridFSBucket` — it is not a Mongoose model, and this plugin never runs
  against it. See the GridFS section below for what does cover it.
- **`insertMany` has no query to scope** — it is a passthrough of documents, not a filtered
  operation. Three call sites exist, all worker-context, all setting `tenantId` explicitly on every
  inserted document: `ingestion.service.ts` (`evidenceChunkModel`), `conflicts.service.ts`
  (`conflictModel`), `facts.service.ts` (`extractedFactModel`).
- **`document.save()` after a fetch is safe only because the fetch was scoped.** A save cannot leak
  a document a scoped query never returned in the first place.
- **A query built inside a request but awaited after the ALS scope exits runs unscoped** — the
  hook fires at `.exec()`/`await`, not at construction, the identical laziness trap
  `auditablePlugin` already documents.

### GridFS specifically

No `DocumentStore` interface or method signature changed. Enforcement here is indirect, by
construction: `GridFsDocumentStore.get(id)` takes a raw GridFS object id, and the only path that
ever produces one is a `document_versions` row's `storageKey` — and `document_versions` reads are
now themselves tenant-scoped, both by the explicit service parameter and by the plugin backstop. A
GridFS key is therefore only discoverable through a row the caller was already authorized to read.
`put()` additionally stamps `metadata.tenantId` on every upload. This is defence in depth, not a
proof: nothing on the `DocumentStore` interface or the bucket itself checks that stamp on `get()`
or `delete()`, and a caller holding a bare object id — from a log line, a stack trace, a bug
elsewhere — could still fetch cross-tenant bytes directly against the bucket. The control is that
nothing in this codebase currently hands out a bare id without a tenant-scoped lookup first.

### The negative-control experiment

This is the strongest evidence in this ADR, and it is an experiment, not an assertion. Run by the
orchestrator, against `test/security/tenant-isolation.e2e-spec.ts`:

1. **Probe 1:** revert `QaService.getAnswerById` to an unscoped `findById(id)`, leave the plugin
   registered. Result: the isolation suite stayed **GREEN**.
2. **Probe 2:** keep that revert *and* disable the plugin's registration in
   `src/config/mongo.config.ts`. Result: the suite **FAILED**, at exactly
   `returns 404, not 403, for tenant B's GET /answers/:idFromA`, with `Expected: 404, Received:
   200` (1 failed / 10 passed).

The conclusion has to be drawn from both probes together, not either alone. Probe 1's green run,
read in isolation, could be misread as "the test doesn't actually cover this path" — a false
negative that would be indistinguishable from a genuinely weak test if it were the only data point.
Probe 2 is what gives Probe 1 its meaning: the same broken service code, with the backstop removed,
fails at the exact assertion the milestone exists to satisfy. That is what proves the plugin was
doing real work in Probe 1, independently of the primary control, rather than the suite simply
never exercising the vulnerable path. A negative control that never fails is not a control; this
one failed at precisely the point predicted, and only when both layers were removed together.

### Scope honesty

Tenant provisioning is deliberately out of scope this cycle. `User.email` stays globally unique —
the unique index is not tenant-scoped, and `user.schema.ts`'s own comment records that as
deliberate, not an oversight. There is no self-serve tenant creation; a second tenant exists only
in test setup (`tenant-isolation.e2e-spec.ts` flips a second registered user onto `'tenant-b'`
directly on the row, then re-logs-in to pick up the new claim). "RBAC" here means exactly two roles
(`UserRole.Admin`, `UserRole.Member`) and exactly one role-gated endpoint,
`POST /api/v1/approvals/:id/decision` — the state at this decision, before later milestones gated
further endpoints; `docs/adr/0020-tenant-invitations-and-the-real-member-role.md` carries the
current route-by-route count. New users default to `Member`
(`user.schema.ts`); pre-migration users were backfilled to `Admin` specifically so existing demo
accounts keep working once the gate lands (`migrations/0010-user-tenancy-and-roles.ts`). Nothing
else in the system checks role. This ADR does not claim more than that, and neither should a reader
of the threat model.

### Cross-tenant reads return 404, never 403

Every tenant-scoped read — `DocumentsService.getById`, `QaService.getAnswerById`, the approvals and
conflicts endpoints — scopes with `findOne({ _id, tenantId })` and raises a not-found exception on
`null`, never a forbidden one. A `403` would confirm the id exists under someone else's tenant; a
`404` makes a wrong-tenant id indistinguishable from one that was never issued at all. This is the
same reasoning `approvals.e2e-spec.ts` already established for a single resource
(`ApprovalsService.decide`'s "belongs to a different tenant" case); `tenant-isolation.e2e-spec.ts`
extends the assertion across every tenant-scoped resource in one pass rather than duplicating it
per feature.

## Known bounds

1. **The plugin depends on every tenant schema declaring a `default` on `tenantId`.**
   `pre('save')` stamps `tenantId` only when `this.isNew && this.$isDefault('tenantId')`, and
   `$isDefault` only reports "unset" when the schema itself declares a `default` (every current
   tenant-scoped schema does, e.g. `evidence-chunk.schema.ts`'s `default: DEFAULT_TENANT_ID`). A
   tenant schema added later without a `default` makes this stamp a silent permanent no-op — a
   schema-authoring contract the plugin depends on and cannot enforce.
2. **GridFS enforcement is indirect, not checked at the storage layer.** As above: the control is
   that nothing hands out a bare object id without a tenant-scoped lookup first, not a check inside
   `GridFsDocumentStore` itself.
3. **`upsert: true` gets whatever tenant the intersected filter or update document supplies, never
   one the plugin adds.** Covered by the same primary-control argument as everything else — the
   explicit-tenant service parameters are what get this right, the plugin was never going to.
4. **Role granularity is two values, gating one endpoint as of this decision.** A member with valid
   credentials can read and write everything else in their own tenant; there is no per-user
   ownership within a tenant, and no role finer than admin/member. Extending `@RequireRole` to a
   second endpoint requires deciding, per endpoint, whether member access to that action is
   actually a problem — it was not evaluated broadly here, only for the one irreversible
   human-judgement action in the system this cycle (ADR-0009's approval decision).
   `docs/adr/0020-tenant-invitations-and-the-real-member-role.md` later extends the gate to every
   other admin-only mutation and audits the full route set.

## Consequences

**Good.** The negative-control experiment demonstrates the two mechanisms are genuinely
independent rather than one silently subsuming the other — either layer alone stops the concrete
leak the milestone was written to close, and only removing both together reopens it. Every existing
tenant-scoped query keeps its explicit parameter, so nothing about this milestone weakens the
control that was already correct; it adds a second one that specifically covers the case where that
discipline lapses.

**Costs.** A pre-migration JWT forces one re-login per active session inside the 7-day expiry
window — a real, if small, user-facing cost chosen over the alternative of trusting a token that
predates tenant claims at all. The plugin's fail-open-outside-a-request behavior means a new
background job that reads a tenant-scoped model without threading `tenantId` explicitly gets no
backstop at all — the plugin's protection is conditional on being inside a request, and that
conditionality is easy to forget precisely because it is invisible when it doesn't apply.

**Deferred, deliberately.** GridFS access is not checked at the bucket layer — only at the
document-row lookup that precedes it. Closing that gap means either threading a tenant check into
`DocumentStore.get`/`delete` (a signature change every implementation, including `FakeDocumentStore`,
would have to honor) or trusting the indirect-discoverability argument this ADR makes explicitly.
That trade was not resolved here; it was named so it isn't mistaken for coverage.

## Interview framing

> The core decision is that neither the explicit tenant parameters nor the global plugin would
> have been enough alone, and for different reasons — the plugin can't see outside a request, so
> the worker and migrations need explicit tenant handling regardless; explicit parameters are
> per-call-site discipline that one forgotten query defeats, so I wanted a backstop that doesn't
> depend on every author getting every query right forever. What I'd flag before anyone else does:
> the plugin fails open outside a request context on purpose — no ALS tenant means it does nothing
> — because the worker, the eval harness, and migrations legitimately have no tenant to enforce,
> and a fail-closed default there would break all three, every time, not just when something's
> actually wrong. The evidence I trust most isn't the code, it's the negative control: reverting one
> service method to an unscoped `findById` left the isolation suite green, because the plugin caught
> it; reverting that *and* disabling the plugin failed at exactly the assertion I expected, with a
> 200 where a 404 belonged. That second failure is what tells me the first green run meant something.
> And I want to be honest about scope — this is two roles gating one endpoint, not a role system,
> and tenant provisioning didn't happen this cycle at all. Cross-tenant reads are 404, not 403,
> everywhere, because a 403 would tell an attacker the id exists.

## Related

- [`threat-model.md`](../threat-model.md) §5 — the residual risk this milestone closes, and what's
  still open.
- `docs/adr/0009-durable-human-approval-gates.md` — the approval-decision endpoint this ADR's one
  role gate protects, and the fail-closed discipline `MongoApprovalChannel.getDecision` extends
  here to cross-tenant ids.
- `docs/adr/0014-tenant-provisioning-and-default-tenant-demotion.md` — closes the tenant-provisioning
  gap this ADR names under "Scope honesty".
- `docs/adr/0020-tenant-invitations-and-the-real-member-role.md` — extends the role gate this ADR
  introduced to every other admin-only mutation, with the current route-by-route count.
