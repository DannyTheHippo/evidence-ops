# Evidence Ops

Precedence per the user-level CLAUDE.md § Precedence: this file and `.claude/project-discovery.json` override user-level defaults. Path-scoped detail lives in `.claude/rules/`; keyword-injected shape references live in `.claude/contexts/`.

## Role

Senior TypeScript full-stack coding agent. NestJS + Mongoose API, React SPA.

## Stack

- **API** (repo root): NestJS 11 on Express, Mongoose 9, `@nestjs/swagger`, `@nestjs/jwt` + bcryptjs, `@nestjs/throttler`, helmet, zod (env parsing, plus the deliberate exception in `src/providers/**`/`answer.contract.ts` for model I/O schemas — see those files), class-validator (requests), class-transformer (responses), migrate-mongo (TypeScript migrations via `tsx`), AsyncLocalStorage request context.
- **SPA** (`web/`): React 19.2, react-router-dom 7.18, Vite 8, plain CSS. No state library, no data-fetching library.
- **Data**: MongoDB via `mongodb/mongodb-atlas-local` — chosen because retrieval depends on `$search`, `$vectorSearch`, `$rankFusion`.
- **Testing**: jest 30 + ts-jest + supertest + mongodb-memory-server (API unit/e2e); a separate `jest.integration.config.ts` lane runs live-Mongo specs against `mongodb/mongodb-atlas-local` (Docker required locally; `.github/workflows/integration.yml` runs it in CI on push and pull request, standing up `mongo` and running migrations first); vitest 4 + Testing Library (SPA).
- **Runtime**: Node 26 (`engines >=26 <27`, `.nvmrc`, `node:26-slim`, CI node 26).
- **Infra**: Docker Compose (mongo + one-shot migrate; app/web behind the `full` profile), GitHub Actions, husky pre-commit.

**Temporal is wired** (ADR-0003), a second process alongside the API: `src/worker/main.ts` boots
`WorkerModule` (a DI slice mirroring `AppModule` minus HTTP-only concerns) and starts a
`@temporalio/worker` `Worker` polling `config.temporal.taskQueue`. `src/workflows/` holds four
workflows — `answer-question`, `ingest-document-version`, `resolve-conflict`, `sync-source` — each
pure orchestration that proxies to activities in `src/worker/activities.ts` for every side effect
(Mongo, model calls, the grounding check). `resolve-conflict` is the one that parks on a durable
human approval signal with a timeout branch, which is why the approval survives a worker restart.

**The MCP surface is a third process** (ADR-0016): `src/mcp/main.ts` boots `McpModule` on the same
`WorkerModule` slice pattern and serves stateless Streamable HTTP, authenticated per call by a
personal access token rather than the SPA's session cookie. It advertises `search_evidence`,
`get_answer` and `request_resolution`; approval-deciding tools are deliberately absent, because the
surface that proposes a resolution must not also convey approval. `src/workflows/**` sits behind a determinism fence (ADR-0003,
`eslint.config.mjs`, enforced again by Temporal's own workflow-bundling step in `Worker.create`):
it may only import from `src/workflows/**` itself and pure type-only files, never services, Mongoose,
or `src/providers/**` directly. `ProvidersModule` binds `WORKFLOW_ENGINE` to the real
`TemporalWorkflowEngine`, and `QaService.startQuestion` calls `start()` on it — so the live path
needs both `docker compose up -d mongo` and a running Temporal dev server (`npm run temporal:dev`,
requires the Temporal CLI) before `worker:dev` can do anything. E2E and unit tests never need
either: `test/utils/create-test-app.ts` overrides `WORKFLOW_ENGINE` back to `FakeWorkflowEngine`.

## Project Structure

Two build roots, **no workspace tooling** — no `workspaces` key, no lerna/nx/turbo/pnpm-workspace. The root drives the SPA with `npm --prefix web`. Dependencies, tsconfigs, and eslint configs are independent; nothing type-checks across the boundary.

```
src/
├── config/            app bootstrap, swagger, mongo, environment (zod) + TypedConfigService
├── database/          global/ (AuditableDocument), plugins/, schemas/{domain}/{entity}/
├── features/{group}/{feature}/   module, controller, service, dtos/{request,response}/,
│                                 exceptions/, api-examples/, decorators/, guards/, types/
├── shared/            constants, decorators, dtos, enums, exceptions, filters,
│                      interceptors, middlewares, services/logger, types, utils
└── main.ts
test/                  mirrors src/; e2e/ and utils/ (shared mock factories)
migrations/            migrate-mongo, TypeScript, numeric prefix
web/src/               main.tsx, App.tsx, api/client.ts, components/, lib/, pages/, styles.css, test/
```

Tests are **not** colocated with API sources — `test/` mirrors `src/`. SPA tests **are** colocated.

## File Naming

kebab-case with a type suffix.

| Type          | Pattern                             |
| ------------- | ----------------------------------- |
| Module        | `feature.module.ts`                 |
| Controller    | `feature.controller.ts`             |
| Service       | `feature.service.ts`                |
| Schema        | `entity.schema.ts`                  |
| Request DTO   | `dtos/request/name.request.dto.ts`  |
| Response DTO  | `dtos/response/name.response.dto.ts`|
| Exception     | `feature.exception.ts`              |
| API examples  | `feature.api-examples.ts`           |
| Type / Enum   | `name.type.ts` / `name.enum.ts`     |
| Unit test     | `test/**/feature.service.spec.ts`   |
| E2E test      | `test/e2e/feature.e2e-spec.ts`      |
| Migration     | `NNNN-description.ts`               |
| SPA page      | `web/src/pages/PascalCase.tsx` + `PascalCase.test.tsx` |

## Coding Rules

- Never commit secrets. **Never read `.env`** — it holds live API keys. `.env.example` is the safe reference.
- `process.env` is read in exactly one file (`src/config/environment/environment.config.ts`). Everywhere else inject `TypedConfigService`.
- Adding an environment variable touches **six** places — checklist in `contexts/configuration.md`. Missing the sixth (`test/utils/get-mock-config.ts`) breaks type-check across every spec.
- All new code ships with tests in the same change. Every new `*.service.ts` needs 100% branch coverage or the build fails (see § Validation).
- Changes minimal and production-ready; preserve existing architecture unless refactoring is the task.
- **FORBIDDEN** to add a dependency unless the task requires it. Prefer the existing `shared/` utilities, base classes, and mock factories.
- **Keep dependencies current, but never blindly.** `npm run deps` (`ncu -u && npm i && husky`) refreshes the root manifest; `web/` has its own manifest and lockfile and is not covered by it. Rules that make this safe:
  - A dependency bump is **its own commit with its own full gate** — `npm run checks:ci` and `npm run checks:web`, both green — never folded into a feature commit. A patch bump is not self-evidently safe: cycle 4 was bitten by a Mongoose 9 behaviour change (`updatePipeline`) that `tsc` could not see and every mocked unit test passed straight through.
  - **`ncu -u` rewrites `package.json` before `npm i` runs.** If the install then fails, the tree is left claiming versions that neither `node_modules` nor the tracked lockfiles have, and `npm ci` breaks. Always check `git diff package.json` after a failed `deps` run and either finish the install or restore the file.
  - **FORBIDDEN** to resolve an `ERESOLVE` peer conflict with `--force` or `--legacy-peer-deps`. A peer range is a claim about what the package was tested against; overriding it installs a combination nobody has verified, and for lint/type tooling the failure is silent wrong answers rather than a crash. Hold the conflicting package back, record why, and re-check when upstream widens the range.
  - Never run an install while tests are executing — the suites read `node_modules` live.
- Run the smallest relevant validation first, then broaden.
- **Comment accuracy is the rule; comment syntax is not.** This section overrides the user-level comment-discipline rule wherever the two differ (per § Precedence).
  - **`//` is legal.** Use it for a short remark on a single statement or branch. Use `/** … */` for anything attached to an exported symbol — module, class, function, schema field, interface member — because those are the comments tooling surfaces on hover and in generated docs. Neither form is a licence to narrate: an unnecessary comment is still noise regardless of syntax. Commented-out code stays forbidden — git holds it.
  - A comment describes **its target**: what this function/class/field/branch is and how it behaves. It must be accurate against the code as it stands right now — a comment that has drifted from its target is a defect, not cosmetic debt, and is fixed in the same change that made it drift.
  - **FORBIDDEN to quote decisions or dates.** No "decided 2026-08-12", no "per the review", no "changed from X to Y", no "ADR-0008 rejected …", no measurement provenance ("measured on express 5.2.1"), no narration of what a previous implementation did. Code comments describe the present state of the code, never its history or the argument that produced it.
  - Decision records, dated findings, measurement provenance, and rejected alternatives belong in `docs/adr/`, the threat model, or the plan file — the places built to hold them, where they can be superseded cleanly. A rationale worth keeping is worth writing where it will be maintained; a rationale inlined as a comment rots silently the moment the code moves.
  - The **behaviour** a rationale protects still gets stated, in present tense and about the code: not "Mongoose 9 started rejecting array updates, found via e2e", but "Pipeline updates require `updatePipeline`; without it the driver rejects the call." State a guard's failure direction the same way — as what it does, not as what was decided.
- Never commit, merge, or rebase — the user commits manually. No remote writes.
- No path aliases in either root; relative imports are the convention.
- Per-project `.claude/settings.local.json` inherits user-level `permissions.deny`/`ask` without downgrade.
- Tool order, Bash guards, file hygiene, and comment discipline: per the auto-loaded user-level rules — not restated here.

## Testing Conventions

- **Extend, don't duplicate.** If an existing test already covers the path under change, extend it. Duplicate coverage dilutes failure signal.
- **New e2e file only on a new return-type contract** (new resource, response shape, or error contract). Everything else extends the e2e that already covers the endpoint.
- Response-shape changes **MUST** be asserted in an e2e — that is the only gate catching a response DTO field missing `@Expose()`.
- Bug fixes carry a regression test capturing the failure mode.
- Mocking matches the nearest sibling test; API specs reuse the factories in `test/utils/`.
- **FORBIDDEN** to leave `.skip`/`xit`, scratch fixtures, or coverage output in the tree.

Detail: `rules/jest-tests.md` (API), `rules/react.md` § SPA Testing (web).

## Discovered Conventions

- **Deny-by-default auth.** `JwtAuthGuard` is a global `APP_GUARD` registered in `AuthModule`. Every new route is authenticated the moment it exists; `@PublicRoute()` is the only escape and applying it is a security decision.
- **Two silent-failure traps.** A response DTO field without `@Expose()` is dropped from the payload (`toResponseDto` uses `excludeExtraneousValues: true`). A request DTO field without a class-validator decorator is stripped, and an unknown field is a 400 (`ValidationPipe` runs `whitelist` + `forbidNonWhitelisted`). Neither produces an error anywhere.
- **Routing.** Global prefix `api`, URI versioning with `defaultVersion: '1'` → `/api/v1/...`. Explicit `@Version('1')` and `@HttpCode()` on every handler. Swagger at `/docs`.
- **Errors.** Feature exceptions extend `BaseException(message, status, cause?)`. A bare `Error` collapses to a 500 `Internal server error` in `GlobalExceptionFilter` and loses the detail; `cause` is how a failure stays debuggable (attached to the body below prod-like environments only).
- **Request context.** `CorrelationMiddleware` + `AsyncLocalStorageMiddleware` are applied globally with an explicit exclusion list; `JwtAuthGuard` stamps the user id into the ALS store, and `auditablePlugin` reads it. A Mongoose Query is lazy — one built inside a request but awaited outside the ALS scope stamps no audit fields, silently.
- **Config refuses at construction.** zod validates `process.env` synchronously during `AppModule` decorator evaluation and aborts boot listing every offending variable. `MONGO_DB_URI` and `JWT_SECRET` are required under `production`/`staging`, dev-defaulted below.
- **zod is for env and model contracts; HTTP DTOs are not.** Requests use class-validator, responses use class-transformer. zod additionally owns `src/config/environment/`, `src/providers/**`, and the model-facing contracts (`answer.contract.ts`, `fact-extraction.contract.ts`) — those schemas must convert to JSON Schema for Anthropic's `output_format`, which class-validator cannot do. Note the provider layer imports `zod/v4` explicitly.
- **SPA API base is relative** — `const API = '/api/v1'`, proxied by Vite in dev and nginx in prod. No `VITE_*` vars, no `import.meta.env`, no hardcoded origins. The session is an HttpOnly cookie the browser sends itself — the SPA holds no credential and there is no `AuthContext`; `ensureSession()` probes `GET /auth/me` once and caches the answer in module scope, and `useSession()` is the reactive shell over it. Both fail closed: a rejected probe resolves to anonymous, never to a stale "probably still signed in".
- **Response contracts are duplicated by hand** across the two roots (`web/src/api/client.ts` interfaces mirror the API response DTOs). Change both in the same commit.
- **Security posture in place:** helmet (CSP off so Swagger UI loads), CORS with an explicit origin, throttler as a global fail-closed guard, bcrypt cost 12 with a dummy-hash compare on unknown-email login for timing parity.

## Validation

`format` and `lint` are **mutating** (`prettier --write` on TypeScript, `eslint --fix`, `markdownlint-cli2 --fix` on Markdown). Use them locally; use the `:check` variants anywhere a gate must be able to fail. Prettier does not run on Markdown.

| Command                | Use                                                                       |
| ---------------------- | ------------------------------------------------------------------------- |
| `npm run checks`       | **Local gate.** format → lint → tsc → test → test:e2e. Rewrites files.     |
| `npm run checks:ci`    | **CI gate.** format:check → lint:check → tsc → test → test:e2e. Fails red. |
| `npm run checks:web`   | SPA: lint → typecheck → test. Note `lint` here is the mutating `--fix` form. |

Individual: `npm run format:check`, `npm run lint:check`, `npm run tsc`, `npm run test`, `npm run test:e2e`; SPA `npm --prefix web run lint:check | typecheck | test | build`.

`npm run test:integration` runs the live-Mongo specs (`*.integration-spec.ts`) against a real
`mongodb/mongodb-atlas-local` container — needs Docker (`docker compose up -d mongo`), 300s test
timeout. Neither `checks` nor `checks:ci` runs it, so a green local gate says nothing about it —
but `.github/workflows/integration.yml` does, on push and pull request, standing up `mongo` and
running migrations first.

**Never claim done while any of these is red**, including pre-existing failures — surface them, fix them, or halt and escalate.

Coverage: `jest.config.ts` requires 100% statements/branches/functions/lines, and `collectCoverageFrom` is scoped to `src/**/*.service.ts` **and `src/shared/utils/**`** (minus config, logger, `main.ts`). Every new service and every shared util needs full branch coverage or the build fails. `shared/utils` joined the gate after a security review found `parse-cookie.util.ts`'s hostile-input handling unpinned precisely because nothing measured it. Controllers, providers, filters and interceptors are deliberately still outside — they are thin and e2e-proven, and pulling them in fails the gate at ~82% today. That is not permission to leave them untested.

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint:check`, `tsc`, `test` as a matrix, plus a `web` job running `lint:check`, `typecheck`, `test`, `build`. `test:e2e` runs in `e2e.yml`. Husky pre-commit runs the mutating `format`, `lint`, `tsc`.

Database: `docker compose up -d mongo` then `npm run migrate:up` before anything that touches Mongo.
