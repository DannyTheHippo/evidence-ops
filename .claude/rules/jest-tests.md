---
paths:
  - "**/*.spec.ts"
  - "**/*.e2e-spec.ts"
  - "test/**"
---

# API Testing Conventions (Jest)

Applies to the NestJS API suites under `test/`. SPA tests use vitest — see `react.md`.

## Layout

- Tests live in `test/`, **mirroring `src/`** — they are not colocated with the source file. `src/features/common/auth/auth.service.ts` is tested by `test/features/common/auth/auth.service.spec.ts`.
- Unit specs: `*.spec.ts`, run by `jest.config.ts` from the repo root.
- End-to-end specs: `test/e2e/*.e2e-spec.ts`, run by `jest.e2e.config.ts` with `rootDir: ./test`.
- Shared mock factories live in `test/utils/`: `get-mock-config.ts`, `get-mock-logger.ts`, `get-mock-model.ts`, `create-test-app.ts`. **MUST** reuse them; do not hand-roll a parallel mock.

## Coverage — 100%, but only on services

`jest.config.ts` sets every global threshold to 100 while `collectCoverageFrom` is scoped to `src/**/*.service.ts` (minus config, logger, and `main.ts`).

- Every new `*.service.ts` needs **full branch coverage** or `npm run test` fails the build. Plan the spec with the service, not after it.
- Everything else — controllers, guards, filters, utils, schemas — is **not measured**. Uncovered does not mean untested-by-policy: cover the behaviour that matters via unit or e2e tests regardless, but know that the coverage gate will not tell you it is missing.
- **FORBIDDEN** to lower a threshold or widen an exclusion to make a change pass.

## E2E: the setup-env ordering constraint

`jest.e2e.config.ts` registers `test/e2e/setup-env.ts` via `setupFiles` — it **must run before any import of application code**. `ConfigModule` validates `process.env` synchronously while `AppModule`'s decorators are evaluated, so a stray top-level import that pulls in `AppModule` ahead of the setup file aborts the whole suite with an environment-validation error that names the wrong culprit.

- **FORBIDDEN** to move environment setup into `beforeAll` or import `AppModule` from a helper that is itself imported at module scope in a setup file.
- E2E suites build the app through `test/utils/create-test-app.ts` and run against `mongodb-memory-server`.

## Unit test structure

- **MUST** use `Test.createTestingModule()` with mocked providers; type mocks against the real interface.
- Mock AsyncLocalStorage as `{ getStore: jest.fn().mockReturnValue({ user: mockMongoId }) }` when the subject reads request context.
- Naming: `it('should [verb] [object]')`.
- **MUST** clean up with `afterEach(() => jest.resetAllMocks())`. When a `jest.fn` carries an implementation, re-set it in `beforeEach` — `resetAllMocks` wipes implementations.
- **MUST** assert on calls, arguments (`expect.objectContaining`), return values, and thrown exception types — not only the happy-path return.

## What to add, and when

- **Unit tests — extend, don't duplicate.** If an existing test already exercises the path under change (same function, same branch, same input shape), extend it. Duplicate coverage dilutes failure signal.
- **E2E — new file only on a new return-type contract.** A new resource, a new response shape, or a new error contract earns a new `*.e2e-spec.ts`. Every other behaviour change extends the e2e that already covers that endpoint.
- Response-shape changes **MUST** be asserted in an e2e. This is the only gate that catches a response DTO field missing `@Expose()` (see `nestjs.md`); `test/e2e/serialization.e2e-spec.ts` is the existing home for that class of assertion.
- A bug fix **MUST** carry a regression test that captures the failure mode.
- **FORBIDDEN** to leave `.skip`/`xit` in committed code.
