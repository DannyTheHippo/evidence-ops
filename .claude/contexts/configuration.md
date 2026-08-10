# Configuration & Environment

`process.env` is read in exactly one file: `src/config/environment/environment.config.ts`. Everywhere else, inject `TypedConfigService` and read a namespace.

```ts
constructor(private readonly config: TypedConfigService) {}
// config.auth.jwtSecret, config.mongo.uri, config.voyage.dimensions
```

**Never read `.env`** — it holds live API keys. `.env.example` is the safe reference and carries no real values.

## Adding an environment variable touches six places

Miss any one of these and you get either a silent default or a project-wide type-check failure:

1. **Schema field** — `environmentSchema` in `src/config/environment/environment.config.ts`. Use the existing helpers: `zBool(default)`, `zNum(default)`, `zNumEnum(default, allowed)`, `zOptionalString()`. Add a `superRefine` clause if it is required in production/staging.
2. **Transform namespace** — the `.transform()` block, which projects raw vars into namespaced objects (`app`, `mongo`, `auth`, `anthropic`, `voyage`, `temporal`, `retrieval`, ...). A new var joins an existing namespace or creates one.
3. **Exported type** — `export type XConfig = EnvironmentConfig['x'];` at the bottom of the same file, if a new namespace was created.
4. **`TypedConfigService` getter** — `src/config/environment/typed-config.service.ts`, `get x(): XConfig { return this.config.get('x', { infer: true }); }`.
5. **`.env.example`** — add the key with a safe placeholder, in the matching `# SECTION` block. Blank (`""`) is the convention for secrets.
6. **`test/utils/get-mock-config.ts`** — builds a complete `EnvironmentConfig`. Until it is updated, the object no longer satisfies the type and **every** spec that imports it fails to compile. This is the step that gets forgotten.

## Validation semantics worth knowing

- An unset var and `VAR=""` mean the same thing — `zOptionalString()` normalizes blank to `undefined`, so `??` fallbacks stay honest.
- `MONGO_DB_URI` and `JWT_SECRET` fall back to dev-only values below prod-like environments and are **required** when `NODE_ENV` is `production` or `staging` (enforced in `superRefine`).
- A parse failure aborts boot with a flattened list of every offending variable. That is deliberate: config refuses at construction rather than failing open per-request.
- `ConfigModule` validates `process.env` synchronously while `AppModule`'s decorators evaluate. That is why `test/e2e/setup-env.ts` must run before any application import (see `rules/jest-tests.md`).

## Scoped notes

- **zod is env-validation only.** Request validation is class-validator; response shaping is class-transformer. Do not reach for zod in feature code.
- **Temporal is scaffolded, not wired.** The `@temporalio/*` packages and the `config.temporal` namespace exist, but there are no `@temporalio` imports in `src/`, no `src/worker/`, and `worker:dev` is a placeholder that exits 1.
