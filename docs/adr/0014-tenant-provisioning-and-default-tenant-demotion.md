# ADR-0014 — Tenant provisioning and default-tenant demotion

- **Status:** Accepted — extended by
  `docs/adr/0020-tenant-invitations-and-the-real-member-role.md`, which adds an admin-minted
  invitation as a second path into a tenant. The bounds below describing no self-serve join and
  co-tenanting as the only way to a second member are this decision's own scope at the time, not
  the system's current one; see that ADR for the invitation flow and its route-by-route role audit.
- **Date:** 2026-08-17
- **Supersedes:** —

## Context

`docs/adr/0011-structural-tenant-isolation-and-minimal-roles.md` named tenant provisioning as
deliberately out of scope: `User.tenantId` existed and was enforced, but nothing created a tenant —
every account backed onto `DEFAULT_TENANT_ID`, the constant `'default'`, and the only way a second
tenant existed at all was a test flipping a row directly. That ADR's own "Scope honesty" section is
explicit about this gap; this milestone closes it.

`AuthService.register` now provisions a tenant per registration instead of joining every account to
the shared default. `User.tenantId` stops being a single seeded value everyone shares and becomes
what its own schema comment always said it should be: a real, per-registrant tenant, required on
every user with no fallback.

## Decision

### Fresh tenant per registration, registrant becomes its admin

`AuthService.register` generates an opaque `tenantId` (`randomUUID()`), creates a `Tenant` registry
row for it, and creates the registering `User` with that `tenantId` and `role: UserRole.Admin` —
not the schema's own default of `UserRole.Member`. The two writes are not atomic across collections,
so if the user creation fails after the tenant row was created, `register` deletes the tenant row it
just created before re-throwing, rather than leaving an orphaned tenant with no member in it. There
is no code path here for a registrant to join an existing tenant without an invitation — the
`tenantId` on a plain registration is never caller-supplied; `RegisterRequestDto` carries no tenant
field of its own. (`docs/adr/0020-tenant-invitations-and-the-real-member-role.md` later adds a
second registration path, keyed by an admin-minted invitation token rather than a caller-supplied
tenant field, so this bound is scoped to plain registration as this decision left it.)

The consequence stated as-is, not redesigned here: because every registrant is the sole admin of a
tenant containing only themselves, the Admin-gated actions in the system at the time this decision
was made — `STEP_MINIMUM_ROLE`'s Admin-floored steps in
`src/features/platform/authz/step-policy.authz-hook.ts`, and the approval-decision endpoint
ADR-0011 introduced — refused nobody who reached them through their own tenant. A role floor only
does work once a tenant has a member who isn't its admin, and nothing in this milestone created that
situation — co-tenanting, below, was the only way one could arise until ADR-0020's invitation flow.

### `email` stays globally unique — deliberate, not an oversight

`user.schema.ts`'s unique index on `email` is not tenant-scoped, and stays that way. Two call sites
depend on exactly that: `AuthService.login` resolves a session with `userModel.findOne({ email })`
alone — there is no tenant selector anywhere in the login request, the SPA's login form, or
`LoginRequestDto`, so a caller who typed only an email and password would have no way to disambiguate
which tenant they meant if the same email could exist in two of them. `scripts/co-tenant-user.ts`,
the operator path below, keys its own lookup the same way —
`db.collection('users').findOne({ email })` — for the identical reason: an operator names a person by
their email, not by which tenant a duplicate row happens to sit in. Tenant-scoped email would make
both call sites ambiguous by construction; global uniqueness is what makes "this email" resolve to
exactly one account.

### `DEFAULT_TENANT_ID` demoted to a seeded dev tenant

`DEFAULT_TENANT_ID` (`src/database/constants/tenant.constant.ts`) still exists — `migrations/0015-
tenants-registry.ts` still seeds a `tenants` row for it — but its role changes from "what every
account gets" to "the floor for contexts that run outside any request." Migrations, the eval
harness, and any process with no authenticated caller to derive a tenant from still need a tenant id
to write under; this constant is that value, never a silent fallback for a request that forgot to
supply its own.

`JwtAuthGuard` enforces the demotion directly: `isProdLike(this.config.app.env) &&
payload.tenantId === DEFAULT_TENANT_ID` rejects the token, below `NODE_ENV=production`/`staging`
only. Below prod-like, `'default'` stays a valid, working tenant — local development and the eval
harness both rely on it continuing to work with no changes. The rejection reuses the exact same
generic message every other failure in that guard already returns
(`'Invalid or expired token'`) — never a distinct one naming the default tenant specifically. That
indistinguishability is deliberate: `DEFAULT_TENANT_ID` is a guessable, shared string, so a caller
who could tell "rejected for carrying the default tenant" apart from "rejected for any other reason"
would have an oracle for which tenant id is the seeded one, worth trying against any other guess. A
uniform rejection message gives an attacker nothing to distinguish the two cases by.

### The operator co-tenanting path

`scripts/co-tenant-user.ts` was, at this decision, the only way a second user joins a tenant someone
else's registration already created, now that registration itself never does by default.
`docs/adr/0020-tenant-invitations-and-the-real-member-role.md` later adds an admin-minted invitation
as a self-serve path for a user who does not yet have an account; this script remains the only path
for moving an *already-registered* user into a different tenant, since invitation redemption refuses
an email that already has one. It is intentionally narrow: it requires
both the target tenant and the user to already exist, sets `tenantId` on the user row and on that
user's `api_keys` rows and nothing else, and refuses outright rather than creating either side
implicitly. The key rows move because they carry their mint-time tenant and
`ApiKeysService.list`/`revoke` match that against the caller's session tenant — a key left in the
vacated tenant would keep authenticating while being invisible and unrevokable to its own owner. It does
not touch `role` — a user moved into a new tenant keeps whatever role they already had, so a
registrant (always `admin` of their prior, now-vacated tenant) arrives as a second admin of the
target tenant, not a member. That is a direct consequence of the field the script deliberately does
not change, not a separate decision made here.

### The drain-in-flight consideration

Temporal workflow histories persist independently of the code that started them, and can be started
before a deploy that changes what an activity requires. `requireTenantId`
(`src/worker/activities.ts`) is the fail-closed check for exactly that gap: every `Activities`
signature already types `tenantId: string`, but that binds new executions only — a history recorded
before the tenant requirement existed can still be replayed, and replaying it supplies no
`tenantId` at all, type or no type. `requireTenantId` throws `ApplicationFailure.nonRetryable(...,
'MissingTenantId')` rather than a plain error: a history that never had a tenant can never acquire
one by retrying, so a retryable failure here would only burn the activity's retry budget reaching
the same result every time. The workflow run terminates in a failed state that a human has to
notice and address — draining or discarding the in-flight history — rather than retrying forever
against a requirement it predates.

## Known bounds

1. **The tenant-creation and user-creation writes in `register` are not one transaction.** The
   compensating delete on user-creation failure narrows the failure window to exactly that one call,
   but does not eliminate a race where the process crashes between the two writes — an orphaned
   tenant with no member can still exist after an interrupted registration. Nothing currently sweeps
   for that condition automatically.
2. **`co-tenant-user.ts` cannot demote a moved admin.** Moving a solo-tenant admin into an existing
   tenant always produces a second admin there; there is no flag or follow-up step in the script to
   set the moved user's role to `Member` in the same operation. An operator who wants that has to run
   a separate update.
3. **Role-gated steps are unverified in the multi-member case.** `STEP_MINIMUM_ROLE`'s Admin floors
   have never been exercised end to end against a tenant containing both an admin and a member — the
   only way to construct that tenant shape today is co-tenanting, which this milestone introduces.
4. **Co-tenanting re-scopes the moved user's personal access tokens, and can only repair a move it
   performs itself.** A moved user's `api_keys` rows follow them into the target tenant, so every
   token they hold immediately acts in that tenant — `ApiKeysService.verify` resolves tenant and
   role live from the `User` row, so the token's reach changes the moment the user row does, with
   no re-mint and no notice to the holder. A token minted for work in one tenant is therefore a
   token for the new one, and revoking it is the only way to stop that. The script short-circuits
   on a user who is already a member of the target tenant, so a key row sitting in a tenant its
   owner has already left is not something a re-run fixes; that needs a direct database update.
5. **The demotion protects the JWT path only.** `JwtAuthGuard`'s prod-like rejection is the sole
   enforcement point for `DEFAULT_TENANT_ID`; nothing prevents a script or a migration run directly
   against the database from writing `tenantId: 'default'` onto a document in a prod-like
   environment. The guard stops a request from authenticating with that tenant; it does not stop
   the tenant id from existing in data.

## Consequences

**Good.** Every pilot registration is isolated by construction the moment it completes, with no
manual provisioning step and no shared starting tenant to accidentally leak data through. The
`'provisions a distinct tenant for each registration'` e2e case
(`test/e2e/auth.e2e-spec.ts`) is the direct evidence: two registrations produce two different
`tenantId`s with no setup beyond calling the endpoint twice. `DEFAULT_TENANT_ID`'s prod-like
rejection closes the specific risk a shared, guessable tenant id created — a stale or hand-crafted
token could otherwise read whatever the seeded dev tenant accumulated.

**Costs.** Co-tenanting is an operator-run script, not a self-serve flow — every pilot with more
than one person in a tenant needs someone with database access to run it. `email`'s global
uniqueness means a person cannot hold separate identities in two different tenants under the same
address; they need a second email if they need to be a genuinely separate account in a second
tenant.

**Deferred, deliberately, as of this decision.** Role demotion on co-tenanting was not built — every
moved user keeps their prior role, and every registrant's prior role is always `Admin`. Neither
trade was resolved here; named so it is not mistaken for having been built by this milestone.
Multi-role-per-tenant provisioning — inviting a chosen role directly, rather than moving an existing
`Admin` — was deferred here too, and was later built by
`docs/adr/0020-tenant-invitations-and-the-real-member-role.md`; co-tenanting is no longer the only
path into a non-solo tenant.

## Interview framing

> The core decision is that registration now provisions its own tenant instead of joining a shared
> one — every new account is isolated the moment it exists, with no manual step and nothing shared
> across registrants by default. What I'd flag before anyone else does: because the registrant is
> always that tenant's sole admin, the Admin-gated actions in the system don't actually restrict
> anyone until a tenant has more than one member, and the only way to get a second member today is
> the co-tenanting script — which deliberately doesn't touch role, so a moved admin arrives as a
> second admin, not a member. I didn't build role demotion into that script; I named it as deferred
> instead of guessing at a policy nobody asked for. The other piece worth being direct about is
> `DEFAULT_TENANT_ID`: it didn't disappear, it got demoted to a seeded dev/migration floor, and the
> guard that rejects it in production returns the exact same generic message as every other bad
> token — on purpose, so a caller can't use the response to figure out which tenant id is the
> guessable one. And the drain-in-flight case is real, not theoretical: a Temporal history started
> before tenancy was required has no tenant to give an activity, and I made that fail non-retryably
> rather than let it burn a retry budget failing the same way forever.

## Related

- `docs/adr/0011-structural-tenant-isolation-and-minimal-roles.md` — the isolation mechanism this
  milestone provisions tenants into, and the "Scope honesty" section this ADR closes the gap named
  by.
- `docs/global/pilot-runbook.md` — the operator-facing co-tenanting procedure, using the same script
  this ADR records the design of.
- `docs/adr/0020-tenant-invitations-and-the-real-member-role.md` — the admin-minted invitation flow
  that extends this ADR's per-registration-tenant decision with a second, self-serve path into an
  existing tenant, and the route-by-route audit of the Admin-gated actions this ADR names.
