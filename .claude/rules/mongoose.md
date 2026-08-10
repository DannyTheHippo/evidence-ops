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

## Migrations

- Tool: `migrate-mongo`, configured in `migrate-mongo-config.js`, run through `tsx`. Commands: `npm run migrate:up` / `npm run migrate:down`.
- Migrations are **TypeScript**, in `migrations/`, exporting `up(db)` and `down(db)`. Follow the existing numeric-prefix naming (`0001-baseline.ts`).
- **MUST** include a migration for every schema change that needs an index or a backfill. Schema decorators alone do not create indexes in a deployed database.
- **FORBIDDEN** to edit a migration that has already been applied anywhere — add a new one. `down()` is the correction path.

## Indexes and search

- MongoDB runs locally as `mongodb/mongodb-atlas-local` (see `docker-compose.yml`) specifically because the retrieval design depends on `$search`, `$vectorSearch`, and `$rankFusion`. A plain `mongo` image will not serve those stages — do not "simplify" the compose service.
- Atlas Search and Vector Search index definitions are **not** Mongoose `@Prop` indexes. Create them explicitly in a migration.
- Compound indexes for frequent multi-field queries; unique indexes on business keys; TTL indexes for expirable documents. Verify a new access pattern with `.explain()` before adding an index on a guess.
