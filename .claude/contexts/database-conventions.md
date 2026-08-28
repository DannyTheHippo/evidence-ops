# Database Conventions

Authoritative rules live in `rules/mongoose.md`. This file is the shape reference.

## Schema — real shape

```ts
export type UserDocument = HydratedDocument<WithTimestamps<User>>;

@Schema({ timestamps: true, collection: 'users' })
export class User extends AuditableDocument {
  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true, index: true })
  email: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
```

Location: `src/database/schemas/{domain}/{entity}/{entity}.schema.ts`. Every mutable entity extends `AuditableDocument` (`createdBy`/`updatedBy`); `timestamps: true` supplies `createdAt`/`updatedAt`.

## Audit stamping runs through AsyncLocalStorage

`auditablePlugin` (`src/database/plugins/auditable.plugin.ts`) reads `als.getStore()?.user` in `pre('save')` and `pre('findOneAndUpdate')`. `JwtAuthGuard` puts the user id there.

A Mongoose Query is lazy — the hook fires at `await`/`.exec()`, not at construction. Build and await inside the same request scope. A query awaited outside it stamps nothing, silently. Migrations and background jobs have no store at all; that no-op is intentional.

Mongoose 9 `pre` middleware is promise-native — there is no `next` callback to call.

## Local MongoDB is Atlas-local on purpose

`docker-compose.yml` runs `mongodb/mongodb-atlas-local`, not the plain `mongo` image, because the retrieval design needs `$search`, `$vectorSearch`, and `$rankFusion`. Swapping the image breaks those aggregation stages. It also gives a single-node replica set, which transactions and change streams require.

## Migrations

`migrate-mongo` in TypeScript, run via `tsx`. Files in `migrations/`, numeric prefix (`0001-baseline.ts`), exporting `up(db)` and `down(db)`. Commands: `npm run migrate:up` / `npm run migrate:down`.

- A schema change that needs an index or a backfill needs a migration entry. `@Prop({ index: true })` does not create the index in a deployed database.
- Atlas Search / Vector Search index definitions are created explicitly in a migration, through `createSearchIndexesWhenReady` — they are not Mongoose indexes.
- While no production database exists, `0001-baseline.ts` is living: add a new named index to its table rather than a new file. It freezes at the first production `migrate:up` — after that, add a new migration instead of editing an applied one.

## Query rules

- Compare ObjectIds with `.equals()`, never `===`.
- `.populate()` selectively, with typed generics; avoid nesting past two levels.
- Verify a new access pattern with `.explain()` before adding an index on a guess.
- Compound indexes for multi-field queries, unique indexes on business keys, TTL for expirable documents.
