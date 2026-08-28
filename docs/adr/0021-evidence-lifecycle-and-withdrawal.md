# ADR-0021 — Evidence lifecycle and withdrawal

- **Status:** Accepted — `SourcesService.runSync`'s absence guards and soft-withdrawal path
  (`sources.service.ts`), `DocumentVersion.withdrawnAt`/`withdrawnReason`
  (`document-version.schema.ts`, `migrations/0029-document-version-withdrawal.ts`),
  `EvidenceRetrievalService.retrieve`'s service-level exclusion, and `PdfParser`'s
  `EmptyPdfTextLayerException` quarantine path (`pdf.parser.ts`) are all implemented
- **Date:** 2026-08-24
- **Supersedes:** —

## Context

`runSync` iterated only the connector's current listing — every file `SourceConnector.listFiles`
returned, once per sweep. A file deleted from the source was simply never named in that listing
again, and nothing else ever noticed: its `Document`, `DocumentVersion`, and indexed
`EvidenceChunk`s stayed retrievable forever, with no signal anywhere that the file behind them was
gone. That contradicted the product's own posture — documents remain in place at the source,
Evidence Ops is not the system of record for them — by letting the index quietly outlive the
source it is supposed to mirror.

Two more gaps followed from the same absence: a scanned PDF with no embedded text layer used to
fail ingestion the same way a genuinely malformed file did, with no way for an operator to tell
"needs OCR, we don't do that" apart from "something broke." And no path existed to remove a
version from retrieval without also destroying the chunks and facts a past `Answer` cites, or that
`ResolutionBacktestService` replays against.

## Decision

### Soft withdrawal, not hard deletion

A version whose source file `runSync` can no longer find is marked `withdrawnAt`/`withdrawnReason`
(`DocumentVersion`, `document-version.schema.ts`) rather than removed. Its chunks and facts are
left exactly as they were. This is deliberate: an audit system that cannot explain a past answer is
not an audit system, and a resolved `Conflict`'s citations, or a `ResolutionBacktestService` replay
of that resolution, both still need to read the fact and the chunk text a withdrawn version
produced. Hard deletion remains available as a separate path —
`DocumentsController.remove` → `DocumentsService.remove`, gated `@RequireRole(UserRole.Admin)` —
for an operator who actually wants the bytes gone.

State the consequence plainly: a withdrawn document's text is still stored and still readable by
anything that bypasses retrieval exclusion (a direct chunk lookup, a backtest replay, a citation on
an old answer). Withdrawal is a **retrieval control**, not a **data-removal control**. Anyone who
needs the underlying bytes gone uses the admin delete path instead.

### Three guards, all failing toward retention

`runSync`'s absence-diff (`sources.service.ts`) never withdraws on the strength of a single sweep.
Three guards sit between "path absent from this sweep's listing" and an actual `withdrawnAt` write,
and every one of them fails toward keeping evidence retrievable rather than toward withdrawing it:

1. **G1 — empty listing.** `files.length === 0 && activeKnown.length > 0` suppresses withdrawal
   for the whole sweep. An unmounted mountpoint's `listFiles` returns `[]` **successfully** — only a
   missing directory throws — so a fresh empty listing against known, non-empty prior state is
   structurally indistinguishable from a source that was genuinely emptied out. Reason persisted:
   `'empty-listing'`.
2. **G2 — proportional circuit breaker.** `absentActive.length / activeKnown.length >
   PROPORTIONAL_ABSENCE_THRESHOLD` (`PROPORTIONAL_ABSENCE_THRESHOLD = 0.5`, so **strictly more than**
   half of the source's still-active known paths absent in one sweep) suppresses withdrawal for the
   whole sweep. This catches a partial mount G1 misses — a listing that is plausibly non-empty but
   still wrong. Reason persisted: `'absence-threshold-exceeded'`.
3. **G3 — two-strike.** A path absent on one sweep only increments that entry's `absentSweeps`;
   withdrawal fires once `absentSweeps >= ABSENT_SWEEPS_BEFORE_WITHDRAWAL` (`= 2`) — the second
   consecutive absent sweep. This closes the write-temp-then-rename window a single-sweep absence
   would otherwise misread as deletion.

When G1 or G2 fires, every entry's `absentSweeps` is left untouched — the increment branch is
skipped entirely, not merely capped. A distrusted listing must not advance the counter, or the
breaker would only delay the eventual false positive by one sweep instead of preventing it. Accepted
cost of all three: an operator who genuinely empties a source gets no automatic withdrawal for what
was in it and has to use the admin delete path deliberately.

`withdrawalSuppressedReason`, when either G1 or G2 fires, is stamped in the same `finalizeSync`
write that persists `fileStates` — `lastWithdrawalSuppressedAt`/`lastWithdrawalSuppressedReason` on
`Source` — so a guard firing is visible to an operator, not a silent no-op.

### Why the withdrawal write happens after the lease compare-and-set

`runSync` calls `DocumentsService.withdrawVersions` only after `finalizeSync` confirms this sync
attempt still owns `syncLeaseToken` — deliberately asymmetric with `syncOneFile`'s uploads, which
run before that same compare-and-set. A lost-lease attempt that writes a duplicate upload is
harmless: content-addressed dedupe absorbs it. A lost-lease attempt that makes evidence
unretrievable is not harmless, and there is no transaction spanning the lease check and the
withdrawal write to fall back on — so the withdrawal only ever executes once the attempt is known to
still be the current one.

### Why the flag lives on the version, not the chunk or the document

A chunk-level flag would have to live inside the Atlas Search index, and mongot indexes
asynchronously — directly contradicting "excluded from retrieval immediately" the moment a sweep
withdraws a version. A document-level flag cannot express the actual shape of the data: a document
can have a withdrawn v1 sitting alongside a live, current v2, and `DocumentVersion` is the only level
where those two states can be told apart at all.

### Why retrieval enforces the exclusion in the service, not the store

`EvidenceRetrievalService.retrieve` filters withdrawn versions out after the store call, not inside
it, because none of the three retrieval stages can express the predicate:

- `$search`'s `compound.filter` takes Atlas Search operators over the indexed collection
  (`evidence_chunks`) and has no cross-collection join to reach `document_versions`.
- `$vectorSearch`'s `filter` clause only reaches paths declared `type: 'filter'` in the vector
  index definition (`migrations/0003-search-indexes.ts`), and today that is `tenantId` alone.
- A post-fusion `$match` would land after `$limit` — a top-k made entirely of withdrawn chunks
  would come back as zero results, with no signal that anything was dropped rather than that
  nothing matched.

`retrieve` instead over-fetches by `RETRIEVAL_OVER_FETCH_MULTIPLIER` (`= 2`), looks up every hit's
owning `DocumentVersion` (already needed for `sha256`), filters out anything with a set
`withdrawnAt`, then re-slices to the caller's requested `limit`. The accepted cost: ANN search is
approximate, so over-fetching changes the candidate pool the store searches, and the resulting
top-k prefix is not guaranteed identical to what a non-over-fetched run would have returned — a
difference that has been observed moving `recallHitRank` between replays of an identical corpus.
That is accepted here, not compensated for.

### Conflicts are deliberately untouched by withdrawal

Nothing in the conflicts path — `ConflictsService`, `ResolutionBacktestService.run`, or the shared
`loadSourceClassByFactId` helper both use — carries a `withdrawnAt` predicate anywhere. Neither the
`DocumentVersion` lookup inside `loadSourceClassByFactId` nor the `ExtractedFact` lookup inside
`ResolutionBacktestService.run` excludes a withdrawn version's facts. This is deliberate, not an
oversight: a `Conflict`'s `factIds` name specific, already-extracted facts, and a resolution
decision made against those facts stays exactly as legible after the source file backing one of
them disappears as it was before.

The invariance property this preserves: **a `ResolutionBacktestService` report is identical before
and after withdrawing every document behind a resolved conflict.** `test/e2e/resolution-backtest.e2e-spec.ts`
exercises this property as a regression test (see Known bounds) — it would fail if either lookup
gained a `withdrawnAt` predicate "for consistency" with the retrieval path.

### Scanned PDFs quarantine rather than fail

`PdfParser.parse` (`pdf.parser.ts`) throws `EmptyPdfTextLayerException` when a document has at
least one page and every page's extracted text is empty — a scanned image with no embedded text
layer, as opposed to a genuinely malformed PDF (`MalformedPdfException`, a different exception for
a different failure). `IngestionService.recordIngestionFailure` routes that one exception type to
`ingestionStatus: 'needs-ocr'` instead of `'failed'`; every other throw reaching that method's outer
catch still resolves to `'failed'`. The exception that produces `'needs-ocr'`,
`EmptyPdfTextLayerException`, is listed by name in `ingest-document-version.workflow.ts`'s
`nonRetryableErrorTypes`, because the outcome is deterministic given the same bytes — retrying buys
nothing until the bytes themselves change. The
four-state ingestion status set is now `'pending' | 'completed' | 'failed' | 'needs-ocr'`
(`DOCUMENT_VERSION_INGESTION_STATUSES`).

One paragraph on a possible future seam, no more: an OCR provider could sit behind an interface the
way `SOURCE_CONNECTOR`, `EMBEDDING_PROVIDER`, and `MODEL_PROVIDER` already do (ADR-0011's seam
pattern), converting a `'needs-ocr'` version's bytes into a text layer `PdfParser` could then chunk
normally. That is a description of a shape, not a design — no interface, no provider, no schema
field for it exists today, and OCR itself is explicitly out of scope for this change and for
`PdfParser`.

## Known bounds

1. **A withdrawn document's text remains fully readable outside retrieval.** Withdrawal excludes a
   version from `EvidenceRetrievalService.retrieve` only; a direct chunk fetch, a citation on an
   answer synthesized before withdrawal, and a `ResolutionBacktestService` replay all still read the
   original text. This is the point of retaining the data (see § Soft withdrawal), stated here as
   the bound it also is: withdrawal is not a confidentiality control.
2. **An operator who genuinely empties a source gets no automatic withdrawal.** All three guards
   (G1/G2/G3) fail toward retention by design (§ Three guards). The admin delete path is the
   deliberate escape hatch, not an oversight.
3. **The conflicts/backtest invariance is pinned by one e2e, not by every call site.**
   `test/e2e/resolution-backtest.e2e-spec.ts`'s `'returns an identical report before and after
   withdrawing every document behind a resolved conflict'` asserts a `GET
   /api/v1/conflicts/resolution-backtest` report is deep-equal (`toEqual`) before and after
   withdrawing every `DocumentVersion` a resolved conflict's facts point to. That test would fail
   the moment `ResolutionBacktestService.run` or `loadSourceClassByFactId` gained a `withdrawnAt`
   predicate — the exact "for consistency" change this bound used to say nothing would catch. It
   still does not exercise every other reader of a withdrawn version's data (a direct chunk fetch,
   an old answer's citation) — only this one report shape is under CI.
4. **Retrieval's over-fetch changes the ANN candidate pool.** `RETRIEVAL_OVER_FETCH_MULTIPLIER = 2`
   is a fixed widening applied unconditionally, not scaled to how many withdrawn versions are
   actually present in a given tenant's corpus. A tenant with many withdrawn versions concentrated
   in the same region of the embedding space could still see a top-k shorter than the requested
   limit after the withdrawn-filter step, the same way a hits-array shorter than `limit` was already
   possible before this change.
5. **OCR is unimplemented.** A `'needs-ocr'` version stays quarantined indefinitely; nothing
   re-attempts ingestion of it automatically, and no admin action converts it to `'completed'` short
   of re-uploading different bytes.

## Consequences

**Good.** A file deleted at the source is now noticed, and its evidence stops being served in new
answers, without destroying the record of what past answers cited or breaking
`ResolutionBacktestService`'s ability to replay a past resolution. A scanned PDF now reaches a
distinct, correctly-labeled terminal state instead of being indistinguishable from a corrupted
file, and the Data Room UI and `DocumentsService.list`'s filter can tell the two apart.

**Costs.** Retrieval always over-fetches by a fixed multiplier now, whether or not the tenant has
any withdrawn versions at all, and that changes the ANN candidate pool relative to a
non-over-fetched run (Known bounds 4). The conflicts/backtest invariance (§ Conflicts are
deliberately untouched by withdrawal) is guarded by one e2e, not by every reader of a withdrawn
version's data (Known bounds 3).

**Deferred, deliberately.** An OCR provider seam (§ Scanned PDFs quarantine rather than fail) is
described, not designed.

## Related

- `docs/adr/0011-source-connector-seam.md` — the connector seam `SOURCE_CONNECTOR` implements, and
  the pattern a future OCR provider seam would follow.
- `docs/adr/0015-survivorship-policy.md` — `resolve-conflict-policy.ts`, unaffected by withdrawal.
- `docs/global/architecture.md` — the evidence lifecycle section this ADR's implementation is
  reflected in.
