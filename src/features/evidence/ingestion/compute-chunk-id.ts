import { createHash } from 'node:crypto';
import type { EvidenceLocator } from '../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';

export interface ComputeChunkIdInput {
  readonly tenantId: string;
  readonly documentVersionSha256: string;
  readonly ordinal: number;
  readonly locator: EvidenceLocator;
}

/**
 * Deterministically derives an `EvidenceChunk`'s identity from what it *is* — the owning tenant,
 * the owning `DocumentVersion`'s content hash, the chunk's ordinal position in `chunkElements`'s
 * output, and its locator — instead of a randomly minted `ObjectId`. `IngestionService
 * .ingestVersion` runs the same parser and chunker deterministically over the same bytes on every
 * call, so re-ingesting an identical `DocumentVersion` reproduces the identical ordinal/locator
 * sequence and therefore the identical set of ids. That is the property `assemble-answer
 * -messages.ts`'s synthesis prompt needs: today it embeds `chunkId` directly into the evidence
 * fence, so a random per-run id makes the prompt (and therefore `ModelReplayCache`'s prompt-hash
 * cache key, ADR-0007) different on every run and the eval replay cache can never hit. This closes
 * that.
 *
 * `tenantId` is folded into the hash so two tenants that happen to ingest byte-identical content
 * never derive the same `_id` — without it, the second tenant's `insertMany` collides on the
 * first's row (`E11000 duplicate key`) and, worse, `IngestionService`'s own cleanup deletes by
 * `documentVersionId`, so it never clears a colliding row it does not own. `tenantId` is a stable
 * value per caller (`'eval'`, `'default'`), not a per-run mint, so including it preserves the
 * replay-cache property that motivated content addressing in the first place: re-ingesting the
 * same bytes for the same tenant still reproduces the same id. `documentId` was considered and
 * rejected for the same slot — it would also fix the same-tenant/two-distinct-document collision
 * (see Known bounds below), but it is minted per document row, and the eval harness deletes and
 * recreates its documents on every run (`eval/ingest-fixtures.ts` wipes the `'eval'` tenant first),
 * so folding it in would reintroduce per-run id drift and break the exact replay property this
 * function exists to provide.
 *
 * Known bound: two genuinely distinct documents *within the same tenant* that happen to produce
 * byte-identical content still collide — this only scopes the id by tenant, not by document. See
 * `docs/adr/0007-eval-replay-cache.md` for where that bound is recorded.
 *
 * `locator` carries `extractorVersion` (see `evidence-locator.type.ts`), so bumping a parser
 * rotates every id it touches. That is deliberate, not a gap: a parser upgrade can shift the
 * offsets/boundaries a citation pins, which is a genuinely different piece of evidence, and a
 * stable id across that change would let a citation silently point at coordinates a newer parser
 * never actually produced.
 *
 * `ordinal` alone already guarantees uniqueness within one ingest (`chunkElements` emits a plain
 * array, walked in order), but `locator` is folded into the hash anyway so the id is derived from
 * what the chunk *is*, not only from where it landed in an internal array — collision-safe even if
 * a future chunker's ordinal assignment changes shape. Locator keys are sorted recursively before
 * hashing (`stableStringify`) so the id depends only on the locator's content, never on whichever
 * property-insertion order a parser happened to construct it in.
 */
export function computeChunkId(input: ComputeChunkIdInput): string {
  const { tenantId, documentVersionSha256, ordinal, locator } = input;

  // Fails CLOSED: this is an identity gate, not a measurement. A malformed input hashed anyway
  // would still produce *a* string — silently breaking both the collision-safety and the
  // cross-run-stability guarantees this function exists to provide, with no error anywhere to
  // catch it.
  if (tenantId.length === 0) {
    throw new Error('computeChunkId requires a non-empty tenantId');
  }
  if (documentVersionSha256.length === 0) {
    throw new Error('computeChunkId requires a non-empty documentVersionSha256');
  }
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error(`computeChunkId requires a non-negative integer ordinal, got ${ordinal}`);
  }

  const canonicalLocator = stableStringify(locator);
  return createHash('sha256')
    .update(`${tenantId}:${documentVersionSha256}:${ordinal}:${canonicalLocator}`)
    .digest('hex');
}

/** Deterministic JSON serialization with object keys sorted recursively, so two structurally
 * identical locators always serialize identically regardless of the property-insertion order the
 * originating parser happened to construct them in. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
