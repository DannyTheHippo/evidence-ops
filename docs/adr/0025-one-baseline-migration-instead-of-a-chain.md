# ADR-0025 — One baseline migration instead of a chain, and what that broke

- **Status:** Accepted — implemented as `migrations/0001-baseline.ts`, verified by differential dump
  against the chain it replaces
- **Date:** 2026-08-28
- **Supersedes:** every numbered migration before it; the chain no longer exists in the tree
- **Amends:** nothing, but it invalidates migration filenames cited in ADRs written before this date
  (see § Consequences)

## Context

The migration chain had grown to 38 files and encoded a history no new deployment traverses. Several
pairs created a collection and later dropped it — the metric-pack governance collections were created,
populated, and then removed within the same development cycle — so a fresh deploy paid for schema that
existed only to be deleted a few files later.

No production deployment of this project exists. Every environment that has ever run these migrations
was created from empty. That makes the chain's ordering guarantees worth exactly nothing and its
surface area a liability: 38 files is 38 chances for an operator's `migrate:up` to fail halfway and
leave a database in a state no file describes.

## Decision

**One migration, `migrations/0001-baseline.ts`, which brings an empty database to the current schema
in a single step.**

It is table-driven. A single `INDEXES` array holds **34 index specifications across 16 collections**;
the collection list is *derived* from that array rather than written out beside it:

```ts
const COLLECTIONS: readonly string[] = [...new Set(INDEXES.map((index) => index.collection))];
```

That derivation is the point. `down()` drops the collections in `COLLECTIONS`, so it is structurally
incapable of dropping less than `up()` creates — a hand-maintained second list is exactly the kind of
thing that drifts silently, and this one cannot. Two Atlas Search index definitions and one seeded
tenant row sit alongside the table.

The whole file is idempotent: `createIndex` against an identical existing index is a no-op, and the
tenant seed is a `$setOnInsert`. Re-running the baseline against a database that already has it is
safe, which matters because the only supported repair for a missing search index is now to clear the
changelog row and re-run.

## How it was verified

Not by reading it. The chain and the baseline were each applied to their own fresh database, both
databases were dumped, and the dumps were diffed:

```
$ diff -u chain.json baseline.json
IDENTICAL: no differences

$ shasum -a 256 chain.json baseline.json
b5e7af6df38c8805a20fa596b303a166fd5f66227f90ff0f7ad3467422074772  chain.json
b5e7af6df38c8805a20fa596b303a166fd5f66227f90ff0f7ad3467422074772  baseline.json
```

**With a negative control**, because a diff that always passes proves nothing: perturbing a single
digit of one TTL value in the baseline made the difference appear in the diff. The comparison
discriminates.

The chain-applied database carries 34 non-`_id` indexes across 17 collections — the seventeenth being
migrate-mongo's own changelog, which the baseline's table does not describe and does not need to.

## Consequences

**Migration filenames cited anywhere are now wrong.** This is the cost of the decision and it was
underestimated. Nineteen references across the repository named files like `0003-search-indexes.ts`,
`0011-tenant-leading-indexes.ts`, `0031-drop-metric-pack-governance.ts` and `0036-user-token-version.ts`.
Most merely misdirected a reader. Two did worse:

- `docs/global/pilot-runbook.md` and `scripts/backup/mongo-restore.sh` both handed an operator
  `db.migrations.deleteOne({fileName: /0003-search-indexes/})` as the remediation for missing search
  indexes. That command now matches nothing and reports success. An operator following it would be
  told the fix had worked, at the moment their retrieval is already broken.

Both were rewritten against the baseline. **A file path in operator-facing text is a load-bearing
claim, not a citation**, and a consolidation that invalidates every path in the repository has to
budget for finding them.

ADRs written before this date still name migrations from the chain. Those are left as written — a
decision record states what was true when it was made, and the Amends/Supersedes headers exist so
history stays legible. This record is the pointer that resolves them.

**Eight migrations were lost rather than folded in.** Migrations `0031`–`0038` were authored during
this cycle and never committed; the consolidation deleted them along with the rest of the chain. They
were recovered to a scratch copy and deliberately not restored: everything they established is present
in the baseline, verified by the dump comparison above, so restoring them would add files whose only
content is a history no deployment traverses. That is the same reasoning as the consolidation itself.

## Falsifiable signal (WATCH)

The baseline is proven against an **empty** database only. Every verification above starts from
nothing, which is the one case a fresh deploy exercises and the one case that cannot reveal an
ordering assumption.

This decision is **indicted** if a `migrate:up` against a database already holding documents fails, or
succeeds while leaving an index the chain would have built — that would mean the baseline encodes
"create from empty" where the chain encoded "evolve from whatever is there", and the answer is a
second migration that reconciles rather than a wider baseline.

It is **confirmed** the first time a database carrying real documents takes the baseline cleanly.

**Resolution:** at the first `migrate:up` against a non-empty database. **Status: Open.**

**Process consequence, independent of that trigger:** until the baseline has been applied against a
production database, it is treated as **living** — new named indexes are added directly to its `INDEXES`
table, and `test/migrations/baseline.spec.ts` enforces that every schema-declared named index appears there.
At the first production `migrate:up`, the baseline freezes: from that point it is an applied migration like
any other, and a new index or backfill goes in a new `NNNN-description.ts` instead.

## Related

- `docs/global/pilot-runbook.md` — the operator procedure for a missing search index
- `docs/adr/0024-what-the-first-measurements-say.md` — the measurement record from the same cycle
