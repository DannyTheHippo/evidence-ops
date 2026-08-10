# Evidence Ops

Precedence per the user-level CLAUDE.md § Precedence: this file and `.claude/project-discovery.json` override user-level defaults. Path-scoped detail lives in `.claude/rules/`; keyword-injected shape references live in `.claude/contexts/`.

## Role

Senior TypeScript full-stack coding agent. NestJS + Mongoose API, React SPA.

## Stack

- **API** (repo root): NestJS 11 on Express, Mongoose 9, `@nestjs/swagger`, `@nestjs/jwt` + bcryptjs, `@nestjs/throttler`, helmet, zod (env only), class-validator (requests), class-transformer (responses), migrate-mongo (TypeScript migrations via `tsx`), AsyncLocalStorage request context.
- **SPA** (`web/`): React 18.3, react-router-dom 6, Vite 6, plain CSS. No state library, no data-fetching library.
- **Data**: MongoDB via `mongodb/mongodb-atlas-local` — chosen because retrieval depends on `$search`, `$vectorSearch`, `$rankFusion`.
- **Testing**: jest 30 + ts-jest + supertest + mongodb-memory-server (API); vitest 4 + Testing Library (SPA).
- **Runtime**: Node 26 (`engines >=26 <27`, `.nvmrc`, `node:26-slim`, CI node 26).
- **Infra**: Docker Compose (mongo + one-shot migrate; app/web behind the `full` profile), GitHub Actions, husky pre-commit.

Scaffolded but **not wired**: Temporal. The `@temporalio/*` packages and `config.temporal` exist; there are no `@temporalio` imports in `src/`, no `src/worker/`, and `worker:dev` exits 1. Do not write code that assumes a running worker.

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
web/src/               main.tsx, App.tsx, api/client.ts, lib/, pages/, styles.css, test/
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
- Run the smallest relevant validation first, then broaden.
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
- **zod is env-only.** Requests use class-validator, responses use class-transformer.
- **SPA API base is relative** — `const API = '/api/v1'`, proxied by Vite in dev and nginx in prod. No `VITE_*` vars, no `import.meta.env`, no hardcoded origins. Auth state is `localStorage`, read per render; there is no `AuthContext`.
- **Response contracts are duplicated by hand** across the two roots (`web/src/api/client.ts` interfaces mirror the API response DTOs). Change both in the same commit.
- **Security posture in place:** helmet (CSP off so Swagger UI loads), CORS with an explicit origin, throttler as a global fail-closed guard, bcrypt cost 12 with a dummy-hash compare on unknown-email login for timing parity.

## Validation

`format` and `lint` are **mutating** (`prettier --write`, `eslint --fix`). Use them locally; use the `:check` variants anywhere a gate must be able to fail.

| Command                | Use                                                                       |
| ---------------------- | ------------------------------------------------------------------------- |
| `npm run checks`       | **Local gate.** format → lint → tsc → test → test:e2e. Rewrites files.     |
| `npm run checks:ci`    | **CI gate.** format:check → lint:check → tsc → test → test:e2e. Fails red. |
| `npm run checks:web`   | SPA: lint → typecheck → test. Note `lint` here is the mutating `--fix` form. |

Individual: `npm run format:check`, `npm run lint:check`, `npm run tsc`, `npm run test`, `npm run test:e2e`; SPA `npm --prefix web run lint:check | typecheck | test | build`.

**Never claim done while any of these is red**, including pre-existing failures — surface them, fix them, or halt and escalate.

Coverage: `jest.config.ts` requires 100% statements/branches/functions/lines, but `collectCoverageFrom` is scoped to `src/**/*.service.ts` (minus config, logger, `main.ts`). Every new service needs full branch coverage or the build fails; other files are not measured, which is not permission to leave them untested.

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint:check`, `tsc`, `test` as a matrix, plus a `web` job running `lint:check`, `typecheck`, `test`, `build`. `test:e2e` runs in `e2e.yml`. Husky pre-commit runs the mutating `format`, `lint`, `tsc`.

Database: `docker compose up -d mongo` then `npm run migrate:up` before anything that touches Mongo.
