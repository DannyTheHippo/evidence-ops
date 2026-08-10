# ADR-0003 — Temporal from day one, with the determinism boundary as the design line

- **Status:** Accepted — dependencies and dev server verified; workflows not yet implemented
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

Answering a question is a multi-step process — retrieve, synthesize, verify grounding, persist —
where the expensive step calls a paid external API, and where a later milestone inserts a human
approval gate that may take hours or days. Three ways to run that:

1. **In-process `async/await`** behind an HTTP request. Simple until the process restarts mid-answer,
   at which point the work is gone with no record of how far it got.
2. **A queue plus a state machine** (BullMQ, SQS + a `status` column). Durable, but the state machine
   is hand-rolled, and "wait for a human for two days" becomes a polling loop over a table.
3. **A durable workflow engine** (Temporal). The orchestration *is* the code; state, retries and
   resumption are the engine's problem.

The human-approval requirement is what settles it. Option 2 can be made to work, but the part being
hand-written — durable state, retry policy, resumption after restart, waiting indefinitely for an
external signal — is precisely what Temporal exists to provide, and getting it subtly wrong is
hard to detect.

## Decision

**Temporal from day one**, with a hard architectural line: **deterministic orchestration is
separated from probabilistic reasoning.** Workflow code decides *what happens next*; every model
call, database read and network request lives in an activity.

This is the same principle as the rest of the system — the model proposes, the application
disposes — expressed in the execution model. A workflow that called an LLM directly would be
non-deterministic on replay and could not be resumed at all.

## The fence, and what actually enforces it

Temporal runs workflow code in a V8 isolate with no Node API access, replacing `Math.random`,
`Date` and `setTimeout` with deterministic shims. The plan called for an ESLint
`no-restricted-imports` zone over `src/workflows/**` forbidding `@nestjs/*`, `mongoose` and
`src/providers/**`.

Research changed the emphasis rather than the decision, and the nuance is worth stating precisely:
**the lint rule is not the mechanism.** It catches the application-specific imports we know are
wrong, but it cannot catch a Node builtin reached transitively through a third-party package. The
worker's webpack-based `bundleWorkflowCode` already fails loudly at bundle time for exactly that,
and there is no official ESLint plugin for it.

So both stay, with honest roles: the lint rule is a fast signal that fails in CI in seconds and
names the offending import; the bundler is the authoritative gate. Presenting the lint rule as the
guarantee would be the mistake.

Acceptance for the implementation step includes a deliberately-added forbidden import, to prove the
fence rejects it rather than assuming it would.

## Wiring to NestJS

Temporal documents no NestJS integration. The community pattern —
`NestFactory.createApplicationContext()` in a dedicated worker entrypoint, with activities as thin
closures resolving services from that context — fits Temporal's "activities are plain async
functions" model and keeps one DI graph across the API and the worker. It is not officially
endorsed, and that is recorded here rather than presented as settled. Community `nestjs-temporal`
packages were not adopted without verifying their maintenance status.

## Consequences

**Good.** Killing the worker mid-answer and restarting it resumes the same answer — which is a
failure/recovery demonstration rather than a claim. The M2 approval gate becomes
`await condition(pred, '24 hours')` plus a signal, not a polling loop. Retry policy, timeouts and
backoff are declarative.

**Costs.** A second process to run and deploy. A local prerequisite (`brew install temporal`, or
the Docker route) beyond `npm install`. Real conceptual overhead: the determinism boundary is
genuinely easy to violate, which is why it is fenced twice.

**Operational caveat worth designing around.** Temporal's activity execution is at-least-once: a
worker crash between executing an activity and reporting its completion re-runs it. For a paid,
non-idempotent LLM call that means a double charge. Activity timeouts are therefore split
deliberately — `startToCloseTimeout` bounds one attempt so a hung call is retried, while
`scheduleToCloseTimeout` bounds the whole lifecycle including retries — with a low
`maximumAttempts` and `nonRetryableErrorTypes` for 4xx classes so a bad prompt is never retried.

**Verified so far.** SDK 1.22.0 installed; `temporal server start-dev` reports `SERVING` with the
Web UI on 8233. No workflow code exists yet, and `worker:dev` deliberately exits 1 rather than
pretending otherwise.

## Interview framing

> The line I care about is that workflow code is deterministic and everything probabilistic lives in
> an activity. What I'd correct in my own original plan: I had the ESLint rule down as the
> enforcement. It isn't — it can't see a Node builtin pulled in transitively. The workflow bundler
> is the real gate; the lint rule is a fast signal that names the file. Keeping both is fine, but
> calling the wrong one the guarantee is how you end up trusting a fence that isn't there.
