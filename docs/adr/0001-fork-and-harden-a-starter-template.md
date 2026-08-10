# ADR-0001 — Fork and harden an existing starter instead of scaffolding fresh

- **Status:** Accepted
- **Date:** 2026-08-10
- **Deciders:** project owner
- **Supersedes:** —

## Context

evidence-ops needs a production-minded TypeScript backend and a small React surface, and it needs
them fast enough that the interesting work — grounded retrieval, provenance, durable workflows —
starts in days rather than weeks. Three options were on the table:

1. `nest new` plus a hand-rolled React app.
2. Fork an existing personal starter (NestJS 11 + Mongoose 9 + Vite/React 18) that already carried
   zod-validated environment config, a deny-by-default JWT guard, correlation-id logging over
   `AsyncLocalStorage`, a global exception filter, and a reusable test-mock set.
3. Adopt a third-party opinionated boilerplate.

The starter's assets are exactly the unglamorous parts that take a week to get right and that a
reviewer will check first. Its liabilities were unknown until inspected.

## Decision

**Fork the starter, then harden it completely before writing a single feature**, and push every
fix back upstream so the starter stops shipping those defects to the next project.

Hardening scope was everything found except RBAC, which is genuinely evidence-ops platform work
(roles, permissions, tenancy) rather than starter-template work and is scheduled separately.

## Alternatives considered

- **Scaffold fresh.** Honest, but re-derives config validation, auth wiring, request-scoped logging
  and test infrastructure that already existed and worked. Rejected on time-to-first-capability.
- **Third-party boilerplate.** Larger surface, unfamiliar conventions, and its own unaudited defect
  set. The whole point of the exercise is to be able to defend every layer; inheriting someone
  else's opinions undermines that.
- **Fork without hardening.** Rejected outright. A defect list you know about and postpone becomes
  a defect list you ship.

## What the audit actually found

The starter looked healthy and was not. The material defects:

| Defect | Why it mattered |
| --- | --- |
| `strictNullChecks: false` alongside `strict: true` | Silently disabled the single most valuable compiler check. Everything downstream was typed optimistically. |
| `plainToInstance` without `excludeExtraneousValues` | Every un-annotated property on a source object reached the response. A serialization boundary that does not exclude is not a boundary. |
| `dotenv` imported but never declared | Worked only by transitive resolution; one unrelated dependency bump away from breaking. |
| No helmet, no rate limiting | — |
| Healthcheck returned a hardcoded `{status:'ok'}` | Reported healthy while the database was unreachable. Worse than no healthcheck, because it is trusted. |
| `createdBy`/`updatedBy` declared but never populated | The audit trail was decorative. |
| `passWithNoTests: true` with zero e2e tests | A green e2e run that asserted nothing. |
| Empty `migrations/` with `autoIndex` on in production | Index builds happened at application boot instead of in a reviewed migration. |
| `web/` outside all lint/format/test tooling | Half the codebase had no quality gate. |
| nginx proxied to a compose service that did not exist | The container topology had never been run end-to-end. |
| Node version spread across `engines`, two Dockerfiles | — |

Three further defects surfaced only when the new tests were actually executed, and are worth
recording because none would have been caught by reading the code:

1. **A blank string is not an absent value.** `.env` carried `JWT_SECRET=""`. The schema used
   `z.string().optional()`, and the fallback used `?? default`, which only catches `null` and
   `undefined`. The empty string sailed through into the JWT signer. Registration worked (it signs
   nothing); login returned 500. Fixed by normalising blank and whitespace-only values to
   `undefined` at the schema edge, so both the production-required check and the development
   fallback see the same truth. The pre-existing test asserted only that validation *did not throw* —
   never the resulting value — which is precisely why it passed against a broken configuration.
2. **`AsyncLocalStorage` does not reach a lazily-executed query.** A Mongoose `Query` returned
   unexecuted from `als.run()` begins executing at `.then()`, by which point the ALS scope has
   exited, so audit middleware sees no user. Confirmed with an isolated probe rather than inferred:
   unexecuted returns no stamp, `.exec()` inside the scope stamps correctly. The plugin was right and
   the test was wrong — but the trap is real for any hand-rolled deferred query, so the caller
   contract is now documented on the plugin itself.
3. **Whoever spawns a process owns stopping it.** The Mongo configuration started an in-memory
   replica set and discarded the handle. Nothing could ever stop it, so every test run ended with
   Jest force-exiting. Fixed by holding the reference and exposing a teardown.

## Consequences

**Good.** Both repositories pass the same gate (format, lint, type-check, unit, e2e). The starter is
now strictly better for every future project. The audit itself is interview evidence: a specific,
falsifiable list of defects with the reasoning for each fix.

**Costs.** Roughly a day before any feature work. Inherited conventions constrain the module layout —
acceptable, since they are consistent and documented.

**Accepted risks.** `exceljs`, needed later for spreadsheet provenance, has not had a meaningful
release since 2023; an actively maintained fork exists if it becomes a problem. The starter's
`autoIndex` is enabled outside memory-server mode, meaning index builds at boot in production; now
that a real migration owns indexes this should be revisited.

## Validation

`npm run checks` (format → lint → type-check → 39 unit tests → 7 e2e tests) and the web lane
(lint, type-check, vitest) pass in both repositories. Every e2e test was executed against a real
MongoDB instance, not asserted into existence.

## Interview framing

> The starter looked fine and had ten real defects, three of which only appeared when the tests
> actually ran. The one worth telling is the blank JWT secret: an empty string is not an absent
> value, `??` does not catch it, and the existing test asserted "does not throw" instead of
> asserting the value — so it passed while login was returning 500. That is the whole lesson about
> what a test is for. I fixed the class of bug at the schema edge rather than the instance, and
> pushed every fix back upstream so the starter stops shipping them.
