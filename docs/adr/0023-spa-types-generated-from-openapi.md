# ADR-0023 — The SPA's response types are generated from the API's OpenAPI document

- **Status:** Accepted — implemented in `scripts/generate-openapi.ts`, `web/package.json`'s
  `openapi:types`, and the type declarations at the top of each section of `web/src/api/client.ts`
- **Date:** 2026-08-27
- **Supersedes:** —
- **Amends:** —

## Context

`web/src/api/client.ts` declared every API response shape by hand. Nothing compared those
declarations against the API's own response DTOs: the two build roots have independent manifests,
tsconfigs and eslint configs, and there is no workspace tooling, so `npm run tsc` and
`npm --prefix web run typecheck` share no types at all. The only mechanism keeping the SPA's belief
about a response aligned with what the API sends was a convention — update both in the same commit —
enforced by nothing.

That convention has now failed twice, in the same way both times, and neither failure was visible to
any gate:

1. A verified-`claims` field went missing from an answer response. Every API test and every SPA test
   stayed green, because each root asserted against its own idea of the shape.
2. `DocumentVersionResponseDto.reducedFidelityReasons` was added to the API and asserted in an e2e —
   a field that names, per version, where ingestion lost fidelity. The hand-copy in `client.ts` was
   never updated, so the field arrived on the wire and stayed invisible to users. Introducing the
   generated types surfaced it immediately as a missing-property error.

The failure mode is not carelessness. It is that a hand-copied contract has no failure signal: the
copy that is wrong compiles, renders, and passes, and the drift only appears as a product defect.

## Decision

The SPA's response types are generated from the API's OpenAPI document. Two commands and two
committed artifacts:

- `npm run openapi:generate` (repo root) boots the Nest graph, emits `web/src/api/openapi.json`, and
  then runs the SPA's `openapi:types`.
- `npm --prefix web run openapi:types` runs `openapi-typescript` over that document into
  `web/src/api/schema.ts`, then formats it with the SPA's own prettier.
- `npm run openapi:check` regenerates both artifacts and fails if either differs from what is
  committed.

`client.ts` derives from `components['schemas']` rather than restating fields. A field the API adds,
drops, or renames therefore lands as a type error in `npm --prefix web run typecheck`.

### Types only — the transport layer stays hand-written

`openapi-typescript` emits types and nothing else: no runtime code, no fetch wrapper, no client
class. That is the whole reason it was chosen over the client generators. Everything `client.ts`
centralizes — the relative `/api/v1` base, `credentials: 'same-origin'`, the 401-redirect rule with
its `/auth/*` exemption, the FormData content-type exception, 204 handling, the per-call timeouts,
`ApiError`/`TransportError` — is deliberate behaviour this codebase owns. A generated client would
have replaced all of it with its own conventions, including its own base-URL handling, which the SPA
specifically does not want (no `VITE_*` variables, no `import.meta.env`, no absolute origin).

### Generation runs the app in preview mode, so no service has to be up

`scripts/generate-openapi.ts` calls `NestFactory.create(AppModule, { preview: true })`. Preview mode
assembles modules and controller metadata without instantiating providers or running lifecycle
hooks, so nothing opens a Mongo connection or a Temporal client. The document builds with neither
Docker nor a Temporal dev server running, which is what makes regeneration a routine step rather
than an environment setup exercise.

The script MUST run under `ts-node` with `tsconfig.ts-node.json`, never `tsx` — the same constraint
that file already documents for every entrypoint building a DI graph, for a second reason here:
`@nestjs/swagger` reads a property's type from `emitDecoratorMetadata` wherever an `@ApiProperty`
omits an explicit `type`, and esbuild does not emit that metadata. Under `tsx` those properties
would silently vanish from the schema, and the generated types would quietly lose fields.

### Both artifacts are committed

`web/src/api/openapi.json` and `web/src/api/schema.ts` are tracked. The CI `frontend` job installs
only `web/`'s dependencies and never has the API's, so a generation step at typecheck time is not
available to it; and the document's own diff is the reviewable signal that an API contract changed.

Neither file is edited by hand — `schema.ts` carries the generator's do-not-edit header, and
`openapi.json` is overwritten wholesale on every run. The root `openapi.json` that
`createSwaggerConfig` writes on a local boot is a different file, produced by a build that applies
the `@nestjs/swagger` CLI plugin; it is now gitignored so the two cannot overwrite each other in
turn.

### One new dependency, dev-only, in `web/`

`openapi-typescript` is a `devDependency` of `web/` alone. Installing it there rather than at the
root keeps the generated artifact and its generator in the same manifest, and keeps the root
install — which every API lane depends on — untouched. It installed without a peer-dependency
conflict, so nothing was overridden.

### Overrides are `StrictOmit`, not `Omit`

Three fields the document types as bare objects (`AnswerResponseDto.outcome`,
`AnswerResponseDto.citations`, and `EvidenceChunkResponseDto.locator`) are discriminated unions the
API describes in prose. `client.ts` keeps its precise local unions for those by omitting the
generated field and intersecting the local one.

Built-in `Omit<T, K>` does not constrain `K` to `keyof T`. If the API renamed one of those fields,
the omit would silently no-op and the local override would re-add a field the API no longer sends —
reinstating exactly the drift this ADR exists to end. `StrictOmit<T, K extends keyof T>` makes that
case fail at the declaration site instead.

## Alternatives rejected

- **Keep hand-copying, enforced by discipline and review.** This is the status quo, and it is the
  alternative with a track record: it produced both failures in § Context, and in the second case a
  reviewer had an e2e assertion in front of them naming the new field. The mechanism has no failure
  signal, so more care applied to it yields no more detection.
- **A generated API client** (`openapi-generator`, `orval`, `hey-api`). Rejected: it replaces the
  hand-written transport layer whose every behaviour is a deliberate decision (§ Types only), pulls
  runtime code into a bundle this SPA keeps deliberately small, and would put the API base URL under
  generator control.
- **Runtime validation at the boundary** (zod schemas generated from the document, parsed per
  response). Rejected for this step: it answers a different question — whether a given payload
  matches — at a per-request cost, while the defect here is a contract the SPA never learned about.
  A type error at build time catches the missing field on every code path at once; a runtime parse
  catches it only where a response actually flows, and only once someone runs that path.
- **Share the DTO types directly across the two roots**, via a workspace or a shared package.
  Rejected: it would introduce workspace tooling this repository has deliberately never had, and it
  would couple the SPA's build to the API's decorators, Mongoose types, and NestJS runtime. The
  OpenAPI document is the seam that already exists.
- **Boot the API and fetch `/docs-json`.** Rejected: it requires Mongo (and therefore Docker) to be
  running before the SPA's types can be regenerated, which makes regeneration something people skip.
  Preview mode gets the same document with nothing running.

## Known bounds

1. **Only the response shapes the document names are generated — roughly half of them.**
   `@nestjs/swagger` registers a component schema for a DTO only where a route declares it as a
   response type. Several `api-examples` entries declare a `description` and an `examples` block but
   no `type:`, so the document carries an example and no schema. Conflicts, approvals, workflow runs,
   audit events, API keys, invitations, canonical entities, retrieved chunks and the source
   class-drift shapes are all in that set, and their interfaces in `client.ts` are still hand-written
   and still unguarded. Adding `type:` to those entries extends the guarantee to them with no change
   to anything in this ADR.
2. **Every list endpoint is unguarded, for the same reason.** No paginated route declares a response
   type, so the document names no schema for the `{ docs, count }` envelope or for its element types.
   `WithCount<T>` stays hand-written, and a list response's element type is only guarded where that
   element's DTO is separately named by a detail route.
3. **Request DTOs are deliberately not adopted.** The document marks a request field as required
   whenever its `@ApiProperty` does not say otherwise, including fields the API defaults when
   omitted — `CreateSourceRequestDto` reports `enabled`, `connectivity`, `reachability`, `tracked`
   and `sourceClass` as required, though the SPA correctly omits all five. Generating request types
   from the document as it stands would force callers to send fields they should not. Request shapes
   in `client.ts` therefore remain hand-written and carry the same drift exposure they always did.
4. **Union-typed fields are as precise as their local override, not as the document.** OpenAPI has no
   representation of the `Locator`, `AnswerOutcome` or `Citation` unions as the API models them, so
   those arrive as bare objects and are overridden locally (§ Overrides). A change inside one of
   those unions is not caught by the generated types; only a change to the field's presence or name
   is.
5. **Regeneration is a step someone runs, not a gate.** `openapi:check` exists and fails on stale
   artifacts, but it is not wired into `checks:ci`. It boots `AppModule` under `ts-node`, which
   type-checks every file it loads, so it reports red for any type error anywhere in `src/` — not
   only for a genuinely stale artifact. Wiring it in belongs after `tsc` in the gate, not beside it.
   Until then, a DTO change accompanied by no regeneration still reaches a commit — the drift lands
   on the next regeneration rather than never. `git diff --exit-code`, which `openapi:check` uses,
   also reports nothing for an artifact that is untracked rather than modified, so the check is
   meaningful only once both artifacts are committed.

## Consequences

**Good.** The class of defect that produced both failures in § Context now fails the build for every
shape the document names. The `reducedFidelityReasons` drift was caught by this change the first time
the types were generated. Reviewers get a diff of `openapi.json` when an API contract moves, which is
a far stronger signal than a diff of two files that happen to agree.

**Costs.** This repository now has codegen and a build-time dependency where it had neither, plus two
generated artifacts in the tree that must never be edited by hand. Regenerating requires the root
install (the SPA alone cannot produce the document), so a change to an API DTO is a two-root
operation even though the two roots still share no build.

**Deferred, deliberately.** Wiring `openapi:check` into `checks:ci` (Known bound 5), adding `type:`
to the `api-examples` entries that lack one (Known bound 1), and declaring a response type for the
paginated envelope (Known bound 2) are all real follow-up work this ADR does not do. Each one widens
the guarantee without changing its mechanism.

## Related

- `.claude/rules/react.md` — its § Data access states that `client.ts`'s response interfaces mirror
  the API's response DTOs and must be updated in the same change. That instruction now applies only
  to the shapes in Known bounds 1–3; for everything else the compiler enforces it.
- `docs/adr/0014-mcp-server-surface.md` — the other consumer of these response shapes. The MCP
  surface builds its payloads server-side and is unaffected by this change.
