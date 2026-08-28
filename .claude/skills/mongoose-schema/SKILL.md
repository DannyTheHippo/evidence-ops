---
name: mongoose-schema
description: Scaffold a Mongoose schema plus its migration in this project's layout
user-invocable: true
argument-hint: <entity-name> <domain>
context: fork
---

# Mongoose Schema Scaffolding

Scaffold the schema described by "$ARGUMENTS". The domain is the folder under `src/database/schemas/` (existing: `administration`).

## 1. Read before writing

- `.claude/rules/mongoose.md` and `.claude/contexts/database-conventions.md`.
- `src/database/schemas/administration/user/user.schema.ts` and `src/database/global/auditable-document/auditable-document.schema.ts`.

## 2. Generate the schema

`src/database/schemas/{domain}/{entity}/{entity}.schema.ts`:

- `export type {Entity}Document = HydratedDocument<WithTimestamps<{Entity}>>;`
- `@Schema({ timestamps: true, collection: '{plural}' })` on a class extending `AuditableDocument`.
- `@Prop({ type, required, ... })` per field — be explicit about `type`, `required`, `unique`, `default`, `enum`, `ref`, `lowercase`, `trim`.
- `export const {Entity}Schema = SchemaFactory.createForClass({Entity});`

Every mutable entity extends `AuditableDocument` so `createdBy`/`updatedBy` are stamped by the global plugin. If a new entity deliberately should not be audited, state why in the summary.

## 3. Add the migration entries

`migrations/0001-baseline.ts` is living while no production database exists (`rules/mongoose.md` §
Migrations) — add the new collection's indexes directly to its `INDEXES` table rather than a new file;
`COLLECTIONS` derives from `INDEXES`, so a new collection needs no separate list update.

- `@Prop({ index: true })` does **not** create an index in a deployed database — the table entry is what does.
- Atlas Search / Vector Search indexes go in the table too, created through `createSearchIndexesWhenReady`
  (`src/features/evidence/retrieval/search-index-readiness.util.ts`) rather than directly — a direct call
  races the Search Index Management service on a cold container.
- After the first production `migrate:up`, `0001-baseline.ts` freezes: add a new
  `{NNNN}-{description}.ts` instead, exporting `up(db)`/`down(db)`, with `down()` reversing `up()`.

## 4. Wire and verify

- Register in the owning feature module: `MongooseModule.forFeature([{ name: {Entity}.name, schema: {Entity}Schema }])`.
- Add response/request DTOs under the feature's `dtos/` — response fields need `@Expose()`, request fields need class-validator decorators (see `rules/nestjs.md`).
- Apply the migration: `docker compose up -d mongo` then `<scripts.migrate:up>`.
- Run `<scripts.checks>` and report the result. Do not claim done on red.

## Index guidance

Compound indexes for multi-field queries, unique indexes on business keys, TTL for expirable documents, sparse for optional-but-queried fields. Confirm a new access pattern with `.explain()` before adding an index on a guess.
