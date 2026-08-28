/**
 * Not a `BaseException`/`HttpException` — same reasoning as `AtlasSearchUnavailableError`: the
 * provider layer runs outside HTTP request scope (a Temporal activity via
 * `EvidenceRetrievalService`, or `eval/run.ts`'s preflight check), so it cannot assume a
 * controller is there to catch it.
 *
 * Sibling to `AtlasSearchUnavailableError`, and a different failure mode: that error means "this
 * server cannot speak Atlas Search at all" (no mongot, or `listSearchIndexes` itself fails). This
 * one means the server *can* — `listSearchIndexes` answered — but one or both of the specific
 * indexes this app queries (`evidence_chunks_search`/`evidence_chunks_vector`,
 * `../retrieval.constant.ts`) are absent or not queryable. That gap is exactly what cost a fully
 * silent eval failure: a recreated `mongot` container lost `/data/mongot`'s index files while
 * `/data/db` (and migrate-mongo's `migrations` changelog inside it) survived untouched, so
 * `migrate:up` reported nothing to do, `$rankFusion` returned zero rows indistinguishable from
 * "no documents matched," and every eval question silently fell back to `insufficient_evidence`.
 *
 * Thrown by `assertRequiredSearchIndexesExist` (`../required-search-indexes.util`).
 */
export interface MissingSearchIndexProblem {
  readonly name: string;
  /** `'missing'`: absent from `listSearchIndexes` entirely. `'not-queryable'`: present but
   *  `status !== 'READY'` or `queryable !== true`. Recovery differs by kind — see the message
   *  this class builds. */
  readonly kind: 'missing' | 'not-queryable';
  readonly detail: string;
}

export class RequiredSearchIndexesMissingError extends Error {
  constructor(problems: readonly MissingSearchIndexProblem[]) {
    const summary = problems.map((problem) => `"${problem.name}" (${problem.detail})`).join(', ');
    const missing = problems.filter((problem) => problem.kind === 'missing');
    const notQueryable = problems.filter((problem) => problem.kind === 'not-queryable');

    const parts = [`Required Atlas Search index(es) not usable: ${summary}.`];

    if (missing.length > 0) {
      // The subtlety worth stating loudly: `npm run migrate:up` alone will NOT recreate these.
      // Its `migrations` changelog collection lives in `/data/db`, which survives independently
      // of `/data/mongot` (the volume that actually holds the index build) — so migrate-mongo
      // still considers "0001-baseline.ts" applied and reports "nothing to migrate" even
      // though the search indexes it built are gone. Anyone who runs `migrate:up`, sees "nothing
      // to do," and concludes the indexes are fine is repeating the exact incident this error
      // exists to prevent. Clearing the changelog row re-applies the whole baseline, which is
      // safe here: every collection and index it creates is idempotent against a store that
      // already carries them, so the only observable effect is the search indexes coming back.
      parts.push(
        `Missing index(es) (${missing.map((p) => p.name).join(', ')}) will NOT be recreated by ` +
          '"npm run migrate:up" alone: migrate-mongo\'s "migrations" changelog collection still ' +
          'records "0001-baseline.ts" as applied. Clear that changelog row first, in ' +
          "mongosh: db.getCollection('migrations').deleteOne({ fileName: " +
          "'0001-baseline.ts' }) — then re-run migrate:up so it actually rebuilds the " +
          'indexes.',
      );
    }
    if (notQueryable.length > 0) {
      // A present-but-not-ready index is mid-build or failed, not gone — clearing the changelog
      // row here would trigger an unnecessary drop-and-rebuild of an index that may finish (or
      // already failed and needs its own investigation) on its own.
      parts.push(
        `Index(es) present but not yet queryable (${notQueryable.map((p) => p.name).join(', ')}) ` +
          'are mid-build or failed — do NOT clear the migrate-mongo changelog for these; check ' +
          '`db.collection("evidence_chunks").aggregate([{ $listSearchIndexes: {} }])` for the ' +
          'current status and wait for a build in progress, or investigate a "FAILED" status.',
      );
    }

    super(parts.join(' '));
    this.name = 'RequiredSearchIndexesMissingError';
  }
}
