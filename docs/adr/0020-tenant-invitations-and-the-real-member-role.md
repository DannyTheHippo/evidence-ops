# ADR-0020 — Tenant invitations and the real Member role: minting, redemption, and the audit that follows

- **Status:** Accepted
- **Date:** 2026-08-18
- **Supersedes:** —

## Context

`ADR-0011` gave the product two roles and exactly one role-gated endpoint,
`POST /api/v1/approvals/:id/decision`, and said so plainly in its own known bounds: "extending
`@RequireRole` to a second endpoint requires deciding, per endpoint, whether member access to that
action is actually a problem — it was not evaluated broadly here". That evaluation could not
happen sooner than this, for a structural reason rather than an oversight: every registration
provisions a brand-new tenant with the registrant as its admin, so no account has ever held the
Member role. `RolesGuard`'s opt-in default — absent `@RequireRole` metadata means a route does not
use roles at all, not "deny" — has therefore been exercised by exactly one caller population,
admins, since roles existed. An admin-only gate that has never refused anyone is not a proven gate.

This milestone closes that gap in three pieces: an admin can mint a single-use invitation into
their own tenant, a person can redeem one at registration and actually become that tenant's first
Member, and — now that a Member can exist — every mutating route and every `STEP_MINIMUM_ROLE`
entry gets checked against a caller who might actually hold that role.

## Decision

### Minting: a token shown once, verified like an API key

`POST /api/v1/invitations` (Admin-only, `invitations.controller.ts`) takes an email and a role.
`InvitationsService.mint` generates a `eo_inv_`-prefixed random token, stores only its sha256 hash
(`Invitation.tokenHash`), and returns the plaintext exactly once in the mint response — nothing
that reads an invitation afterward, including `GET /api/v1/invitations`'s list, can reproduce it.
Verification (`InvitationsService.verify`) compares with `timingSafeEqual` behind an explicit
equal-length guard, because that function throws on mismatched buffer lengths rather than returning
`false`; the `api-keys` feature is the precedent this shape is reused from verbatim, down to the
digest-length check. An invitation to an email that already has an account is refused at mint,
before a token is even generated. No email is sent — the admin hands the token over however they
already communicate, which keeps the surface small for a pilot run a handful of times. Invitations
expire `INVITATION_TTL_DAYS` (7) after minting, a fixed platform constant rather than a config knob,
mirroring `MAX_ACTIVE_KEYS_PER_USER`.

### Redemption: the invitation dictates identity, never the caller

`AuthService.register` takes an optional `invitationToken`. When present, `email` is not read from
the request at all — the invitation's own email, tenant, and role become the new account's, so the
person who registers is provably the person who was invited, not whoever happened to hold the link.
`verify` fails CLOSED: an unknown token, an expired one, or one already redeemed all return `null`,
and every one of those refuses registration with a 400 rather than falling back to provisioning a
fresh tenant. That fallback was the one behavior this change could not tolerate even accidentally —
a stale or mistyped token silently becoming a brand-new org signup is invisible to the admin who
sent it and is the opposite of what the invitee asked for. An invitation whose email already has an
account is refused the same way, and that account is left untouched — not moved, merged, or
re-tenanted — because email is globally unique in this system and relocating a live account into
another tenant on an admin's say-so is exactly the consent problem ADR-0011 already declined to
solve. The invitation is marked accepted only after the user row actually exists, so a failure
between verification and account creation leaves the token still redeemable rather than burning it
on a registration that never completed.

Two SPA screens ship with this: an invite-redemption form and an admin panel listing pending
invitations, built from the existing `Table`/`Pager`/`Badge`/`EmptyState` primitives — no new UI
vocabulary. Member became reachable at this exact point: the e2e proves it by watching a Member,
minted this way, get refused an admin-only route for the first time in the product's history.

### The audit: every mutating route, checked against a caller who can now hold the lesser role

With Member finally reachable, every mutating route and every `STEP_MINIMUM_ROLE` entry was walked
against it. ADR-0011's own bound is the discriminator used throughout: a route is gated only where
the Member-access problem is articulable, never because a route merely "feels" administrative.

| Route | Role floor | Verdict |
| --- | --- | --- |
| `POST /auth/register`, `POST /auth/login` | `@PublicRoute()` | Correct — pre-authentication. |
| `POST /auth/logout` | none | Correct — a caller ending their own session needs no role. |
| `POST /invitations`, `GET /invitations` | Admin | Correct, unchanged — minting tenant membership is inherently an admin action. |
| `POST /documents` (upload) | none | Correct — a Member contributing evidence is the product's core write path; nothing about uploading is more consequential than asking a question, which is also ungated. |
| `DELETE /documents/:id` | Admin | Correct, unchanged (ADR-0011's one pre-existing gate's sibling) — deleting evidence is irreversible. |
| `POST /questions` | none | Correct — the core Reach capability every account needs. |
| `POST /conflicts/:id/resolution-requests` | none | Correct — this only *proposes* a resolution; the durable human decision it starts is still Admin-gated at `POST /approvals/:id/decision`. Proposing carries the risk of noise, not of an unreviewed write. |
| `POST /approvals/:id/decision` | Admin | Correct, unchanged — ADR-0011's original gate, the one irreversible human-judgment action. |
| `GET /retrieval/search` | none → **made explicit** (Member, Admin) | **Gap closed, but not an access change.** See below. |
| `POST /sources` (create) | none → **Admin** | **Gap closed.** See below. |
| `PATCH /sources/:id` (enable/disable) | none → **Admin** | **Gap closed.** See below. |
| `POST /sources/:id/sync` | none | **Left open, deliberately.** See below. |
| `POST /api-keys`, `DELETE /api-keys/:id` | none | Correct — both scoped by `actorId` in the service layer; a Member mints and revokes only their own tokens, and ownership is the real boundary here, not role. A Member's own PAT still cannot reach `mcp-mutate` regardless of who minted it. |

#### `RetrievalController`: the floor made visible, not changed

`GET /retrieval/search` carried no `@RequireRole` before this change. Under `RolesGuard`'s opt-in
default, absent metadata means "no role check" — every authenticated tenant member, Member or
Admin, could already call it. Its MCP twin (`'mcp-read'` in `STEP_MINIMUM_ROLE`, `search_evidence`
over MCP) states a Member floor explicitly. The two facts together mean this was the only ungated
path to raw corpus text on the browser surface *by omission*, not by design, while the same
capability over MCP was stated on purpose.

**Decision: state the floor explicitly** — `@UseGuards(RolesGuard)` + `@RequireRole(UserRole.Member,
UserRole.Admin)`, matching the six other role-gated controllers' pattern exactly. This changes
nothing about who can call the route today; a Member could always reach it, and listing both roles
grants the identical population `RolesGuard`'s default already granted. The value is legibility: the
boundary is now stated at the route rather than implied by an absence a future reader could misread
as an oversight, and it stays correct if a third role is ever added — an unguarded route would
silently admit it, an explicit list would not. `test/e2e/retrieval.e2e-spec.ts` gained a Member-200
regression proving the floor grants, not narrows, access.

#### Sources: `create`/`setEnabled` gated, `sync` deliberately not

`POST /sources` and `PATCH /sources/:id` configure and toggle which external location feeds the
tenant's evidence corpus — a decision that affects every member of the tenant continuously, not a
one-time personal contribution the way a document upload is. Disabling a source with `PATCH` is the
sharper case: it silently halts corpus freshness with no trace visible to anyone except whoever
happens to check the source list. Both are now Admin-gated (`@UseGuards(RolesGuard)` +
`@RequireRole(UserRole.Admin)`), matching `documents.controller.ts`'s `remove` pattern exactly, with
`sources.e2e-spec.ts` extended to prove a co-tenanted Member gets 403 on both.

`POST /sources/:id/sync` is **left open to any role, on purpose**. Unlike `create`/`PATCH`, it does
not change what the tenant's ingestion pipeline is configured to do — it operates a source an admin
already configured and enabled, and the workflow run it starts deduplicates against one already in
flight (`SourcesService.requestSync`). A Member triggering a sync of an already-approved source is
no more consequential than a Member asking a question, which is also ungated. `sources.e2e-spec.ts`
gained a Member-202 test alongside the two 403 tests, so the deliberate non-gate is provable rather
than merely asserted.

#### The MCP/HTTP asymmetry is intentional, and the mirror image of the retrieval question

`STEP_MINIMUM_ROLE`'s `'mcp-mutate'` (`request_resolution` over MCP) floors at Admin, one level
above `'mcp-read'`'s Member floor — the same action, `POST /conflicts/:id/resolution-requests`,
sits at no role floor at all over HTTP. This is not an inconsistency to reconcile; the map's own
comment names why: the durable human approval `request_resolution` starts writes a `WorkflowRun`
and an `Approval` inbox row reachable by an AI client holding a long-lived PAT while reading corpus
content that can carry prompt injection. A non-interactive credential proposing a consequential
write needs a higher bar than an interactive human doing the same thing through the browser, where
the browser session itself is the harder-to-forge credential. HTTP and MCP floors are allowed to
differ deliberately on exactly this axis — credential risk, not action risk — and this audit is the
first place that asymmetry is written down rather than left implicit in a single inline comment.

### Two dead `STEP_MINIMUM_ROLE` entries removed

`'qa-answer'` and `'data-room-export'` had no production `ToolExecutionStep` caller: a repo-wide
grep for `stepId:` across `src/` returns exactly two literals, `'mcp-read'` and `'mcp-mutate'`
(`src/mcp/mcp-tools.ts`), both already covered above. `'qa-answer'` and `'data-room-export'`
appeared only as literals inside test files (`step-policy.authz-hook.spec.ts`,
`mcp-server.service.spec.ts`, `test/security/canary.spec.ts`) — the last of which exercises
`DenyAllAuthzHook`, a binding that never reads `STEP_MINIMUM_ROLE` at all, so its use of the
`'qa-answer'` string was never actually coupled to this map. Both entries are removed; every test
that referenced them by name now exercises `'mcp-read'`/`'mcp-mutate'` instead, against the same
production steps the map actually governs, closing a gap between what the tests demonstrated and
what the map actually contains. The map's own fail-closed default — a `stepId` absent from the map
is refused, not allowed (`StepPolicyAuthzHook.authorize`) — means removing a dead entry cannot make
a call reachable that wasn't already; removing a live one would have.

### SPA gating: a finding for R4, not work done here

`SourcesPage` and `SourceDetailPage` currently render the create form and the enable/sync controls
to every authenticated user regardless of role. With `create`/`setEnabled` now Admin-gated at the
API, a Member submitting either form gets a 403 with no role-aware affordance in the UI — the same
class of gap `DocumentDetail.tsx`'s `canDelete` pattern (`session.me.role === 'admin'`, gating the
delete control's visibility rather than letting a Member click into a failure) already closes for
document deletion. `SourcesPage`/`SourceDetailPage` are rebuilt substantially by steps R3/R4 later
in this cycle (owner/reach columns, drift detection, a confirm dialog); adding role-conditional
rendering now would be rewritten within hours and risks colliding with that rebuild. **This is
recorded here as a finding for R4 to apply `DocumentDetail`'s pattern to the create form and the
enable/sync controls**, not implemented in this change.

### Two roles stay two roles

This audit evaluates access more broadly than ADR-0011 did, but it does not add a third role or any
per-resource permission. Member only became reachable tonight — there is no operational experience
yet with how a real Member uses the product, and adding finer-grained permissions ahead of that
experience would be designing against a usage pattern that does not exist yet, the same reasoning
Govern's deferral rests on elsewhere in this cycle. `ROLE_RANK`'s two-entry shape
(`step-policy.authz-hook.ts`) and `RolesGuard`'s membership check both stay exactly as they were.

## Known bounds

1. **The SPA does not yet reflect the routes this audit gated.** A Member using `SourcesPage`
   today can submit the create form or click a disable/sync toggle and receive a 403 with no
   inline explanation — the API refuses correctly, but the UI does not yet tell them why before
   they try. Named as a finding for R4 above, not resolved here.
2. **`POST /sources/:id/sync` has no rate limit specific to a Member abusing it.** It was judged
   safe to leave open because it operates existing config and deduplicates against an in-flight
   run, not because it is bounded by a dedicated throttle — the general per-route throttling this
   cycle's Phase H work applies is the only ceiling on it today.
3. **Ownership-scoped routes (`api-keys`) were not re-examined for a role dimension.** They were
   correctly left alone by this audit because ownership, not role, is already the right boundary
   for a personal credential — but that judgment was not stress-tested against a scenario this
   cycle didn't construct (e.g., an admin needing to revoke a departing Member's own key), which
   remains genuinely open.

## Consequences

**Good.** Member is now a role someone can actually hold, and every admin-only gate in the codebase
has been exercised against a caller who is not automatically exempt from it, for the first time.
The audit found two real gaps (`sources` create/enable) and closed them, found one gap that was
already closed by construction (`retrieval`) and made it legible, and found one deliberate non-gate
(`sources/:id/sync`) worth stating rather than leaving silent. The two dead `STEP_MINIMUM_ROLE`
entries are gone, and every test that used to reference them now exercises the production steps the
map actually governs.

**Costs.** `sources.e2e-spec.ts` and `retrieval.e2e-spec.ts` each co-tenant a second user, adding a
registration round-trip to their `beforeAll`/test bodies — a small, fixed cost against the value of
proving the gate rather than asserting it. The SPA now silently 403s a Member on two source actions
until R4 closes the UI gap named above.

**Deferred, deliberately.** A third role or per-resource permissions, for the reason stated above:
no operational experience yet. The SPA role-conditional rendering for sources, deferred to R4
specifically to avoid a diff that step immediately rewrites.

## Interview framing

> The core decision here isn't really about invitations — minting and redeeming a token is the easy
> half, and it follows the `api-keys` precedent closely enough that there wasn't much to decide.
> The half worth defending is the audit that follows from Member finally being reachable. ADR-0011
> said explicitly it hadn't evaluated this broadly, only for one endpoint — I used that as the
> literal test: gate a route only where I could name the specific problem a Member's access causes,
> never because a route felt administrative. That's why `sources create`/`setEnabled` are gated
> (they silently change what feeds the whole tenant's corpus) and `sources/:id/sync` isn't (it
> operates config an admin already blessed). And I want to flag the retrieval decision specifically,
> because it's easy to misread: making the floor explicit on `GET /retrieval/search` didn't close a
> hole — a Member could already reach it under the guard's own opt-in default. It closed a
> legibility gap, not an access gap, and the ADR says so rather than implying otherwise.

## Related

- `docs/adr/0011-structural-tenant-isolation-and-minimal-roles.md` — the two-role system and the
  one gate this audit extends; its own known bound 4 is the discriminator this ADR applies broadly
  for the first time.
- `docs/adr/0009-durable-human-approval-gates.md` — the approval decision `POST
  /conflicts/:id/resolution-requests` only proposes toward, which is why proposing stays ungated.
- `docs/adr/0016-mcp-server-surface.md` — `STEP_MINIMUM_ROLE` and the `'mcp-read'`/`'mcp-mutate'`
  split whose credential-risk reasoning this ADR extends to explain the HTTP/MCP asymmetry.
