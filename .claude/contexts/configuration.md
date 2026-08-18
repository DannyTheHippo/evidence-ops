# Configuration & Environment

`process.env` is read in exactly one file: `src/config/environment/environment.config.ts`. Everywhere else, inject `TypedConfigService` and read a namespace.

```ts
constructor(private readonly config: TypedConfigService) {}
// config.auth.jwtSecret, config.mongo.uri, config.voyage.dimensions
```

**Never read `.env`** — it holds live API keys. `.env.example` is the safe reference and carries no real values.

**Never render `docker compose config` unfiltered either.** It resolves every `env_file` entry and prints the values inline under each service, so a full render leaks the same credentials the rule above protects. To check a compose change, grep the output for the specific non-secret keys under test.

## Adding an environment variable touches six places

Miss any one of these and you get either a silent default or a project-wide type-check failure:

1. **Schema field** — `environmentSchema` in `src/config/environment/environment.config.ts`. Use the existing helpers: `zBool(default)`, `zNum(default)`, `zNumEnum(default, allowed)`, `zOptionalString()`. Add a `superRefine` clause if it is required in production/staging.
2. **Transform namespace** — the `.transform()` block, which projects raw vars into namespaced objects (`app`, `mongo`, `auth`, `anthropic`, `voyage`, `temporal`, `retrieval`, ...). A new var joins an existing namespace or creates one.
3. **Exported type** — `export type XConfig = EnvironmentConfig['x'];` at the bottom of the same file, if a new namespace was created.
4. **`TypedConfigService` getter** — `src/config/environment/typed-config.service.ts`, `get x(): XConfig { return this.config.get('x', { infer: true }); }`.
5. **`.env.example` or `docker-compose.yml`, depending on what the variable is.** These are not interchangeable and the split is the point:
   - **A credential, a spend ceiling, or the provider switch** (API key, `JWT_SECRET`, `MODEL_SPEND_DAILY_LIMIT_USD`, `AGENTIC_MAX_COST_USD`, `MODEL_PROVIDER`) → `.env.example`, blank (`""`) for credentials, a real value otherwise. Nothing else belongs in that file; it is short so it stays auditable, and the ceilings sit beside the keys they bound.
   - **Any other knob** → `docker-compose.yml`, as `${VAR:-default}` in the `x-app-environment` anchor (all application processes), or on the individual service if only that process reads it.
   - Two precedence rules decide whether a variable may appear in both places, and they point opposite ways. An inline `environment:` value beats `env_file`, so a **spend ceiling must never** be declared in compose — it would silently override the operator's. But Compose also reads `.env` for `${VAR}` interpolation, so a variable named in compose *with a default* still honors `.env`; that is how `MODEL_PROVIDER` appears in both without conflict.
   - The host dev loop reads neither compose nor its defaults — it falls back to the zod default from step 1, which is why every knob needs one.
6. **`test/utils/get-mock-config.ts`** — builds a complete `EnvironmentConfig`. Until it is updated, the object no longer satisfies the type and **every** spec that imports it fails to compile. This is the step that gets forgotten.

**Six is the floor, not the ceiling.** Some specs build a namespace-shaped literal inline instead of going through `getMockConfig`, so adding a field to an existing namespace breaks them too — `tsc` is what finds them, and it only finds them after step 1 lands. Known offenders: `test/providers/embedding/voyage-embedding.provider.spec.ts`, `test/providers/model/anthropic-model.provider.spec.ts`. `test/utils/get-mock-typed-config.ts` needs a new **namespace** added by hand and will NOT fail type-check when you forget, because it casts through `unknown` — check it explicitly whenever you create a namespace. After finishing the six, run `tsc` and treat every "missing property" error as part of this same change.

## Validation semantics worth knowing

- An unset var and `VAR=""` mean the same thing — `zOptionalString()` normalizes blank to `undefined`, so `??` fallbacks stay honest.
- `MONGO_DB_URI` and `JWT_SECRET` fall back to dev-only values below prod-like environments and are **required** when `NODE_ENV` is `production` or `staging` (enforced in `superRefine`).
- A parse failure aborts boot with a flattened list of every offending variable. That is deliberate: config refuses at construction rather than failing open per-request.
- `ConfigModule` validates `process.env` synchronously while `AppModule`'s decorators evaluate. That is why `test/e2e/setup-env.ts` must run before any application import (see `rules/jest-tests.md`).

## Scoped notes

- **zod is env-validation only.** Request validation is class-validator; response shaping is class-transformer. Do not reach for zod in feature code.
- **Temporal is wired** (ADR-0003). `src/worker/main.ts` boots `WorkerModule` and starts a `@temporalio/worker` polling `config.temporal.taskQueue`; `ProvidersModule` binds `WORKFLOW_ENGINE` to `TemporalWorkflowEngine`. The live path needs both `docker compose up -d mongo` and `npm run temporal:dev`. Unit and e2e specs need neither — `test/utils/create-test-app.ts` overrides `WORKFLOW_ENGINE` back to `FakeWorkflowEngine`.
