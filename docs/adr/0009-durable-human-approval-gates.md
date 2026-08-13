# ADR-0009 — Durable human approval gates: a signal wakes, a row decides

- **Status:** Accepted
- **Date:** 2026-08-11
- **Supersedes:** —

## Context

ADR-0003 named the requirement before any of this existed: a human approval gate that may take
hours or days, wired as `await condition(pred, '24 hours')` plus a signal rather than a polling
loop. This ADR is that promise made concrete, across three increments (D1–D3) plus a fourth that
tests whether the design generalizes (D5): `ApprovalChannel` (persistence), `resolveConflict`
(the first gated workflow), `ApprovalsService.decide()` (the HTTP decision boundary), and
`ingestDocumentVersion`'s own opt-in gate.

Three designs for "wait for a human":

1. **A request-scoped promise** — `await new Promise((resolve) => (pendingResolve = resolve))`,
   resolved later by an HTTP handler holding a reference to `pendingResolve`. Simplest to write,
   and wrong for exactly the reason ADR-0003 chose Temporal at all: the promise, and the closure
   holding it, live in one process's memory. A worker restart — deploy, crash, routine
   recycling — loses the wait with no record it ever existed, the identical failure mode ADR-0003
   rejected for the answer pipeline itself, now reopened for a wait that can legitimately outlive
   a worker by days.
2. **A polling flag** — a `status` column an activity re-checks on a timer (`sleep` + loop). Durable
   across restarts, but it is a state machine hand-rolled on top of the state machine Temporal
   already is: retry policy, backoff, and "how often is often enough without hammering Mongo" all
   become code this system would own and could get subtly wrong in ways tests do not show —
   ADR-0003's Option 2, rejected there for the same reason it is rejected here.
3. **A durable signal plus `condition()`.** Temporal persists the wait itself as part of the
   workflow's event history. A worker crash mid-wait resumes the same wait on replay, at whatever
   attempt/timeout state it was at — no closure, no polling, no separate state machine.

Option 3 is what ADR-0003 already committed to in the abstract; this ADR is choosing how the
*wake-up* and the *verdict* relate once that commitment has to become real code.

## Decision

### The wake-up is a signal; the verdict is a Mongo read, never the signal's payload

A workflow that has requested approval registers a signal handler and waits on
`condition(() => signaled, '24 hours')`. The handler's only job is flipping `signaled` to `true` —
it never reads the signal's payload as the decision. On waking, the workflow calls
`getApprovalDecision(approvalId)`, which re-reads the durable `Approval` row and is the only thing
that decides the outcome.

This split exists because a signal is not an authenticated channel to the workflow's own logic —
it is an RPC any caller holding a `workflowId` can send, including a caller who guessed or leaked
one. If the signal's own payload were trusted as the verdict, forging an approval would be as easy
as sending `{ claimedDecision: 'approved' }` to the right workflow id. Treating the signal as
nothing but a wake-up and re-deriving the verdict from a row that only `ApprovalsService.decide()`
(itself behind normal HTTP auth) can write closes that gap: a spoofed or stale signal wakes the
workflow, which then reads the same row it would have read anyway and finds it still says
whatever a real human actually decided — or still `pending`, if nobody has.

### A timeout is not an approval

`condition()` returning `false` means 24 hours passed with no signal. Both gated workflows treat
that branch as its own terminal outcome (`timed_out`) and never call `getApprovalDecision` at all
— there is nothing to read that a timeout would make meaningful, and falling through to a decision
read would blur "nobody answered" into whatever a stale or default row happened to say.
Independently, `MongoApprovalChannel.getDecision` (`src/providers/approval-channel/mongo-approval.channel.ts`)
would collapse an unanswered `pending` row to `rejected` if it were ever called anyway — a second,
belt-and-suspenders fail-closed for the same fact, reached by two different paths depending on
whether the workflow noticed the timeout itself or asked the channel.

### The gate fails closed

Two independent mechanisms enforce this, deliberately not one: `getDecision`'s own `state !==
'approved'` check (never a truthiness check — a malformed or unexpected state string does not
accidentally pass), and the workflow's own `!woke` branch never reaching a decision read. Either
one alone would be enough; both exist because a permission gate earning its only trust from a
single code path is one refactor away from losing it silently. `resolve-conflict.workflow.ts` and
`ingest-document-version.workflow.ts` both fail this direction for the same reason: an approval
gate is a permission boundary, not a measurement — a broken or ambiguous check must deny, never
wave a consequential action through by default (`rules/code-hygiene.md` § Failure-direction
declaration).

### D5: the same machinery, generalized, opt-in

`ingest-document-version.workflow.ts` reuses `resolveConflict`'s exact discipline — same signal
name (`'approvalDecision'`), same wake-up-not-verdict handler shape, same fail-closed timeout
branch — behind `input.requireApproval`, a plain boolean carried on the workflow's own input
rather than a persisted per-document setting. Two reasons for that placement. First, the
fields-not-imports rule the determinism fence already imposes on this directory: a workflow may
not reach into Mongoose to look up a standing policy, so any gate condition has to travel in on
`input` the same way `resolveConflict`'s own `winningFactId` does. Second, and more basic: gating
is a property of *this upload*, not of the document as an ongoing entity — a re-upload of the same
document later is a free choice to gate again or not, not something a stored flag should decide on
its author's behalf indefinitely. It lives on `UploadDocumentRequestDto`, threaded through
`DocumentsService.upload()` into `IngestDocumentVersionInput`, and defaults to absent/`false` — an
ordinary upload is never blocked. That default is not a convenience; it is the point being tested.
A demo where every upload stalls pending approval is a worse demo than one where the machinery is
available but not mandatory, and what D5 exists to prove is that the signal-plus-durable-row
discipline generalizes to a second kind of gated action, not that ingestion itself needs gating.

A rejected or timed-out gate never runs the ingest pipeline at all, so the version's own
`ingestionStatus` stays at its schema default of `'pending'` — truthfully, since ingestion
genuinely never started. No new persisted state was added to represent "blocked pending approval";
the `Approval` row already carries that record on its own.

## Known bounds

1. **The interface split D1 had to make, and why one blocking call could not work.**
   `ApprovalChannel` is two methods — `requestApproval` returning a handle, `getDecision` reading
   the row — not one call that blocks until a human answers. A single blocking `requestApproval`
   would have to sleep for up to 24 hours *inside a Temporal activity*, and activities are not
   built to durably sleep: an activity's liveness is the worker process's liveness, so a
   day-long in-activity sleep reintroduces exactly the "the wait dies with the process" failure
   ADR-0003 rejected the request-scoped-promise design for. Splitting the contract moves the actual
   waiting into the workflow itself, where `condition()` is durable across a worker restart by
   construction; `requestApproval` only ever does one fast insert, well inside any activity
   timeout.

2. **`getDecision` is not tenant-scoped at the provider level.** `MongoApprovalChannel.getDecision`
   reads `approvalModel.findById(approvalId)` — no `tenantId` filter. That is safe only because its
   one caller inside a workflow (`getApprovalDecision`, an activity) holds an id it minted itself
   moments earlier via its own `requestApproval` call in the same execution; it was never handed an
   id from an untrusted source. `ApprovalsService.decide()` (D3), the HTTP-facing caller, does not
   inherit that trust — a caller there supplies an arbitrary approval id — so it scopes at its own
   boundary instead: `approvalModel.findOne({ _id: id, tenantId })` before ever touching
   `getDecision`'s code path. The scoping is real, but it lives one layer up from the provider, on
   the assumption that every future caller of `getDecision` is either a workflow with a
   self-minted id or a caller that scopes itself first. A new caller that is neither would silently
   inherit a cross-tenant read.

3. **The approval request is a non-idempotent insert.** `MongoApprovalChannel.requestApproval` is
   `approvalModel.create(...)` — an insert, not an update against an existing row. Temporal's
   activity execution is at-least-once (ADR-0003's own operational caveat, restated here for a new
   case): a worker crash between the insert succeeding and the activity reporting completion
   causes a retry, and that retry creates a *second* pending `Approval` row for the same gate
   rather than being a safe no-op. Both `resolve-conflict.workflow.ts`'s
   `approvalRequestActivities` and `ingest-document-version.workflow.ts`'s own copy keep
   `maximumAttempts` low for this reason — the same operational caution the rest of this codebase
   applies to every other non-idempotent write, not a gap specific to approvals. An orphaned
   duplicate row is not cleaned up automatically; it sits in `listPending`'s inbox as a second,
   harmless-but-confusing entry for the same underlying gate until a human decides it (or it times
   out) alongside the row that actually matters.

4. **A timeout leaves the `Approval` row `pending` forever, and a late decision on it still writes,
   then fails to wake anything.** The timeout branch in both workflows only ever touches the
   *conflict*/*version* outcome — it never writes back to the `Approval` row itself, which stays
   `state: 'pending'` indefinitely. That row keeps appearing in `ApprovalsService.listPending`'s
   inbox after the workflow it was for has already finished. If a human decides it anyway,
   `decide()` still persists the decision (the record is not wrong to keep), but the subsequent
   `workflowEngine.signal()` call throws `ApprovalSignalFailedException` against a workflow
   execution that is no longer waiting — the decision landed with nothing left to wake.

## Consequences

**Good.** The wait survives a worker restart because Temporal, not this codebase, owns persisting
it — proven by ADR-0003's own restart-and-resume framing, now exercised by a wait that can span
days rather than an in-flight answer. The verdict can never be forged by anything that merely
knows a `workflowId`, because knowing it only earns the right to wake the workflow, not to tell it
what a human decided. And the second gated workflow (D5) needed zero new durability primitives —
same signal name, same `condition()` call, same fail-closed branch — which is itself the evidence
that the discipline generalizes rather than being wired specifically to conflict resolution.

**Costs.** Every gated workflow duplicates the same `defineSignal`/`setHandler`/`condition` block
rather than sharing one helper — `src/workflows/**`'s determinism fence makes a shared runtime
helper awkward across files that must each independently type-check as pure orchestration, so the
two copies are kept in sync by comment cross-reference (each doc comment names the other) rather
than by import. A third gated workflow would need to remember to copy the pattern correctly rather
than being unable to do otherwise.

**Deferred, deliberately.** Reconciling a timed-out `Approval` row's `state` (bound 4) was left
open rather than designed here — closing it means deciding what a workflow-side timeout should
write back to a row it does not otherwise touch, and getting that wrong (e.g., a workflow marking
a row `'rejected'` that a human decides half a second later) is worse than the current confusing
but harmless double-entry in the inbox.

## Interview framing

> The core decision is narrow: a signal only ever wakes a workflow, it never tells it what a human
> decided — the workflow re-reads a Mongo row for that, every time. I did that because a signal is
> reachable by anyone who has a workflow id; trusting its payload would mean forging an approval is
> as easy as sending the right message to the right execution. The row is the only thing an
> authenticated HTTP endpoint can write, so it is the only thing allowed to mean something. The
> second thing I'd flag before anyone else does: I split `ApprovalChannel` into two calls instead of
> one blocking call specifically because Temporal activities cannot durably sleep for a day —
> `requestApproval` does one fast insert, and the actual day-long wait lives in the workflow's own
> `condition()`, which is the part Temporal actually persists. And I generalized the gate to a
> second workflow — document ingestion — behind a plain opt-in flag defaulting to off, because the
> thing worth proving wasn't that ingestion needs gating, it's that the same durable discipline
> works twice without a third primitive.
