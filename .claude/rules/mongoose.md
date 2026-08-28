---
paths:
  - "**/*.schema.ts"
  - "**/*.plugin.ts"
  - "**/migrations/**"
---

# Mongoose & Migration Conventions

## Schemas

- **MUST** use `@Schema({ timestamps: true, collection: '...' })` + `@Prop()` decorators + `SchemaFactory.createForClass()`.
- **MUST** extend `AuditableDocument` (`src/database/global/auditable-document/`) for every mutable entity — it carries `createdBy`/`updatedBy`.
- **MUST** export the hydrated document type alongside the class: `export type XDocument = HydratedDocument<WithTimestamps<X>>`.
- Location: `src/database/schemas/{domain}/{entity}/{entity}.schema.ts` (e.g. `administration/user/user.schema.ts`). Keep the domain folder — it is the seam the schema set grows along.
- **MUST** compare ObjectIds with `.equals()`. **FORBIDDEN** to use `===`/`!==` — reference equality fails on distinct instances with the same hex value.
- **FORBIDDEN** to weaken a `required` constraint to make a test pass — fix the test data.

## The audit-stamp caveat

`auditablePlugin` reads the current user from AsyncLocalStorage inside `pre('save')` and `pre('findOneAndUpdate')`. A Mongoose Query is **lazy**: the hook fires at execution (`.exec()`/`await`), not at construction. A query built inside a request but awaited outside the ALS scope stamps nothing — silently, with no error. Keep the whole chain inside the request's async context; do not hand a half-built query to a deferred callback, a `setTimeout`, or a detached promise.

Migrations, seeds, and background jobs run with no ALS store at all. That is a deliberate no-op, not a bug to "fix" by faking a store.

`tenantScopePlugin` reads the same ALS store, at the same lazy-query moment, and shares this exact caveat — but not its consequence. A missed audit stamp on `auditablePlugin` is a gap (`createdBy`/`updatedBy` stay blank). A missed tenant predicate on `tenantScopePlugin` is a leak (the query runs against every tenant, not none).

## Aggregation-pipeline updates need an explicit opt-in

Mongoose 9 rejects an array update — `updateMany(filter, [{ $set: … }])` — with `Cannot pass an array to query updates unless the 'updatePipeline' option is set`. Pass `{ updatePipeline: true }` as the third argument whenever the update is a pipeline (`$setDifference`, `$cond`, any `$expr`-style computation over the document's own fields).

This one bites twice over. It is a **runtime** throw, not a type error, so `tsc` is green; and every unit spec here mocks the model, so a `jest.fn()` accepts the two-argument call and passes. The failure surfaces only as a 500 from the real endpoint under e2e. When you write a pipeline update, **assert the options argument in the unit spec** (`DocumentsService.remove`'s conflict pull does) — otherwise the mock is agreeing with you rather than checking you.

## Migrations

- Tool: `migrate-mongo`, configured in `migrate-mongo-config.js`, run through `tsx`. Commands: `npm run migrate:up` / `npm run migrate:down`.
- Migrations are **TypeScript**, in `migrations/`, exporting `up(db)` and `down(db)`. Follow the existing numeric-prefix naming (`0001-baseline.ts`).
- **MUST** add a migration entry for every schema change that needs an index or a backfill. Schema decorators alone do not create indexes in a deployed database.
- **The baseline is living while no production database exists.** Add a new named index directly to `migrations/0001-baseline.ts`'s `INDEXES` table — `test/migrations/baseline.spec.ts` requires every schema-declared named index to appear there. **FORBIDDEN** to edit `0001-baseline.ts` once a production database has taken it — from that point add a new `NNNN-description.ts` instead. `down()` is the correction path.
- A new Atlas Search / Vector Search index must still be created through `createSearchIndexesWhenReady` (`src/features/evidence/retrieval/search-index-readiness.util.ts`), never directly — it gives the Search Index Management service up to 120s to become reachable on a cold container, and a direct `createSearchIndexes` call races that service, making `npm run migrate:up` fail intermittently.
- **Editing the living baseline does not reach a database that already ran it, and nothing warns you.** `migrate-mongo` records `0001-baseline.ts` in the `migrations` collection on first apply and never re-runs it, so a later `npm run migrate:up` exits 0 having done nothing while the new index is absent. Verified: after a baseline edit added `users_tenantId_createdAt`, a successful `migrate:up` left the `users` collection holding only `_id_` and `users_email_unique`. Nothing catches it — `test/migrations/baseline.spec.ts` compares schema declarations against the **file**, never the file against the **database**, and CI stands up a fresh Mongo so it always sees the full baseline. The failure is silent and one-directional: queries still return correct results, just via collection scans, so an index-dependent acceptance check passes in CI and is false locally. **After editing the baseline, reset your local database** — `npm run migrate:down && npm run migrate:up`, or drop it and re-migrate — and confirm the new index with `db.<collection>.getIndexes()` rather than trusting a green `migrate:up`.

## Indexes and search

- MongoDB runs locally as `mongodb/mongodb-atlas-local` (see `docker-compose.yml`) specifically because the retrieval design depends on `$search`, `$vectorSearch`, and `$rankFusion`. A plain `mongo` image will not serve those stages — do not "simplify" the compose service.
- Atlas Search and Vector Search index definitions are **not** Mongoose `@Prop` indexes. Create them explicitly in a migration.
- Compound indexes for frequent multi-field queries; unique indexes on business keys; TTL indexes for expirable documents. Verify a new access pattern with `.explain()` before adding an index on a guess.
