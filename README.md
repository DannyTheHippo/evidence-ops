# Evidence Ops

An AI-native evidence and workflow platform: a NestJS 11 + Mongoose 9 REST API with a separate
Vite/React SPA in `web/`. Currently at the end of its foundation milestone — JWT auth, typed
environment config, correlation-id logging, migrate-mongo migrations, and a validation gate that
can actually fail.

## Prerequisites

- Node.js 26 (`.nvmrc`; `engines` pins `>=26 <27`, and both Dockerfiles use `node:26-slim`)
- Docker (for MongoDB — see below)
- Temporal CLI, for the local workflow dev server (`brew install temporal` on macOS). The dev server's Web UI runs on port 8233. Without Homebrew, `temporalio/docker-compose` is the alternative.

## Setup

```bash
cp .env.example .env
docker compose up -d mongo
npm install
npm run migrate:up
npm run start:dev
```

The SPA lives in `web/` and talks to the API via a Vite dev proxy:

```bash
npm --prefix web install
npm --prefix web run start:dev
```

`docker-compose.yml` runs `mongo` as `mongodb/mongodb-atlas-local` — not the plain `mongo` image —
because the retrieval design depends on `$search`, `$vectorSearch` and `$rankFusion`. It
self-manages its single-node replica set (also what transactions and change streams need), so no
manual `rs.initiate` is required. A one-shot `migrate` service applies migrations. `app` and `web`
services exist under the `full` compose profile; the default `up` starts only `mongo` and `migrate`.

## Scripts

| Script                                | Purpose                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run checks`                      | **local** gate — auto-fixes: format + lint + tsc + test + test:e2e                    |
| `npm run checks:ci`                   | **CI** gate — check-only: format:check + lint:check + tsc + test + test:e2e           |
| `npm run checks:web`                  | the `web/` lane: lint + typecheck + vitest                                            |
| `npm run test`                        | unit tests with coverage (100% branches/functions/lines/statements on gated services) |
| `npm run test:e2e`                    | end-to-end suites against `mongodb-memory-server`                                     |
| `npm run migrate:up` / `migrate:down` | apply/roll back migrations in `migrations/`                                           |
| `npm run format` / `format:check`     | prettier `--write` / `--check` on `src`, `test`, `migrations`, `scripts`, `eval`       |
| `npm run lint` / `lint:check`         | eslint `--fix` / read-only on `src`, `test`, `migrations`, `scripts`, `eval`           |
| `npm run tsc`                         | `tsc --noEmit`                                                                        |
| `npm run test:integration`            | live-Mongo suites against `mongodb/mongodb-atlas-local` — needs Docker; not run by `checks`/`checks:ci` or CI |
| `npm run temporal:dev`                | starts a local Temporal dev server (`temporal server start-dev`)                      |
| `npm run worker:dev`                  | starts the Temporal worker (`src/worker/main.ts`); needs a running Temporal server to connect to |

`format` and `lint` rewrite files and always exit 0, so they cannot serve as a gate. Anywhere a
check must be able to fail — CI, a pre-merge hook — use `format:check` / `lint:check`, which is what
`checks:ci` and `.github/workflows/ci.yml` run.

Swagger/OpenAPI docs are served at `/docs` once the app is running.

## Scope notes

- No generated `openapi-client` package — the SPA uses a hand-written fetch client.
- The SPA stores its JWT in `localStorage`; httpOnly-cookie hardening is flagged as future work.
