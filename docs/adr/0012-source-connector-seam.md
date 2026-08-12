# ADR-0012 — Source connector seam: a port for pulling evidence in, a workflow for keeping it fresh

- **Status:** Accepted
- **Date:** 2026-08-12
- **Supersedes:** —

## Context

Every document ingested so far arrives by a human uploading it. That does not match how evidence
actually accumulates in a live deal: a shared folder, a CRM-derived line-of-business database, or a
property-management system keeps producing new or changed files on its own schedule, and nobody
wants to re-upload the same folder by hand every time something changes. `Source` is the record of
one such location; this ADR is the seam that reads it, the loop that keeps it current, and the
guards that keep a recurring, unattended read from becoming the least-trusted code path in the
system.

## Decision

### The connector is a provider, not a service

`SourceConnector` (`src/providers/source-connector/source-connector.interface.ts`) is a two-method
port — `listFiles`, `fetchFile` — bound behind `SOURCE_CONNECTOR` in `ProvidersModule`, the same
seam `DOCUMENT_STORE`, `WORKFLOW_ENGINE`, and `RETRIEVAL_STORE` already use (ADR-0006 established
the pattern for model access; this is the same shape applied to a different external boundary).
`SourcesService` depends on the interface, never on `LocalFolderSourceConnector` directly, for the
same reason every other provider in this codebase is a port: the thing on the other side is
untrusted, external, and swappable. A future connector kind — reading from an object store, a
CRM's document API, a property-management system's export feed — binds a second implementation
behind the same two methods without `SourcesService` changing at all; `Source.kind` is the
discriminator the module wiring reads to choose which implementation applies. This could not have
been a plain injectable service, because a service in this codebase is business logic that owns
Mongo access and audit recording — a connector owns neither. It only reads bytes from somewhere
this process does not control, which is exactly the shape a provider exists to isolate: fake it in
unit tests (`FakeSourceConnector`), swap it in production, and never let `SourcesService`'s tests
depend on a filesystem or a network call.

### Sync is a Temporal workflow with a sleep loop, not a cron job

A source's sync loop is `syncSource` (`src/workflows/sync-source.workflow.ts`): one workflow
execution per source, each iteration calling the `runSourceSync` activity and then `sleep`-ing for
the resulting interval before sweeping again, bounded by `continueAsNew` after
`MAX_ITERATIONS_BEFORE_CONTINUE` iterations to keep the execution's replay history from growing
without limit. This is the same durability argument ADR-0003 already made for the answer pipeline
and ADR-0009 made for an approval wait, applied a third time to a different shape of "wait, then
resume": a scheduler outside the workflow engine — a cron entry, a `setInterval` in the API
process — would have to track, independently, which sources are due, survive a process restart
without losing that schedule, and avoid two schedulers racing to sync the same source at once.
Temporal already owns exactly that problem for a workflow's own `sleep`: the wait is part of the
workflow's persisted history, a worker restart resumes it at the same point rather than losing it,
and one execution per source means there is structurally only one place a sync attempt for that
source can be in flight, not two schedulers that have to coordinate.

### `syncWorkflowId` is the duplicate-loop guard; `syncLeaseToken` is the concurrent-write guard

These are two different problems and two different mechanisms, not one covering for the other.

`Source.syncWorkflowId` records the workflow id of a source's currently-running loop.
`SourcesService.requestSync` checks it before starting a new execution: if the named workflow is
still `running` (`WorkflowEngine.status`), the call returns the existing `WorkflowRun` projection
instead of starting a second loop. This guard is best-effort by design — `WorkflowEngine.status`
fails OPEN to "not running" on a lookup failure, the same posture `WorkflowRunsService.peekRun`
takes for an identical call — because it is a convenience against an obviously redundant request
(a user clicking "sync now" twice), not the thing that actually prevents two loops from corrupting
each other's writes if the check itself ever raced or lied.

That correctness backstop is `Source.syncLeaseToken`, a compare-and-set token minted fresh by each
`runSourceSync` activity attempt. `claimAttempt` unconditionally stamps a new token onto the source
row; `finalizeSync` writes the sweep's results back only if the row's `syncLeaseToken` still matches
the one this attempt claimed. An attempt that loses the race — superseded by a newer claim before it
finishes — finds `finalizeSync` matches nothing, discards its own results, and reports
`intervalMs: null` so the workflow's loop exits this execution cleanly rather than either
overwriting a newer attempt's work or claiming the source is disabled when it is not. This mirrors
`IngestionService.ingestVersion`'s identical two-part lease discipline for a version's ingestion
attempt, applied here to a recurring loop instead of a once-and-done job.

### Path containment fails closed: lexical, then real

`LocalFolderSourceConnector` resolves every `relativePath` against a configured root
(`config.sources.inboxDir`) and enforces containment twice before it will read anything.  The
lexical check rejects an absolute path outright and rejects any resolved path whose relation to the
root is `..` or starts with `../` — catching `../../etc/passwd`-shaped traversal before touching the
filesystem. That check alone is not sufficient: a symlink sitting inside the root can point to a
target outside it, and resolves lexically to an in-root path while its real target does not. The
second check calls `realpath` on both the candidate and the root and re-applies the same
relation test to the resolved, symlink-following paths. Either check failing throws
`SourcePathEscapesRootError` — a validator sitting on a boundary between "what a source is
configured to read" and "what this process is allowed to touch" is a permission gate, not a
measurement, and a permission gate that cannot prove containment must refuse the read rather than
guess. A path whose `realpath` call itself fails (nothing exists there yet) is not treated as an
escape — there is nothing to compare against, so containment falls back to the lexical result
already established, and the resolved (not real) path is what gets read, since the containment
check exists only to detect an escape, never to substitute a rewritten path for the one a caller
actually asked for.

### Per-file sync failure is open; the sweep as a whole is not silently lossy

`SourcesService.syncOneFile` catches every failure for one file — an oversized read, an unresolvable
document type, the upload call itself — and records it on that file's own `SourceFileState` entry
rather than aborting the sweep. One bad or oversized file in a folder of a thousand must not block
the other 999 from syncing; a recurring loop that halts entirely on the first file it cannot read
would make the whole source unusable until a human intervenes; a *skip and keep the last error
visible per file* posture keeps that decision granular. This is failure-open in the sense that
matters here: the operation being guarded is "keep the source's state current," not "grant
something," so a broken file must never block its unrelated siblings. The sweep's outcome as a
whole is a different case: `runSync` always persists `lastSyncStatus`/`lastSyncError` on the
`Source` row itself, whether the sweep as a whole succeeded or the connector's own `listFiles` call
failed outright — a caller reading a source's status is never left guessing whether the last attempt
ran at all. A brand-new file that fails has no prior `SourceFileState` entry to attach an error to,
so it is logged rather than half-persisted (there is nothing coherent to write, since
`SourceFileState.documentId` is required); it is simply retried on the next sweep, since a missing
entry reads as "new" again.

### The 50MB cap is enforced twice, not once

`MAX_FILE_SIZE_BYTES` (`src/features/evidence/documents/documents.constant.ts`, shared with the
manual-upload path) gates a synced file at two different points. The connector's `listFiles` stat —
`file.sizeBytes`, taken before any read of the file's contents — rejects an oversized file before
`fetchFile` ever loads it into memory. This check exists specifically because this path's entire
purpose is reading files nobody handed the process directly; an unbounded read driven by whatever a
configured folder happens to contain is not acceptable regardless of what the file claims to be. The
second check, against `content.length` after `fetchFile` returns, is not redundant with the first:
a stat taken at list time can be stale by the time the fetch actually runs (the file can grow between
the two calls), so the post-fetch check is the authoritative one against the bytes actually read,
and the pre-fetch check is the cheap guard that keeps a large file from ever being read into memory
at all. Neither replaces the other.

### Rejected alternatives

- **A single "sync everything on this schedule" cron endpoint**, rather than per-source workflow
  executions. Rejected for the same durability reason as the workflow decision above, plus a
  correctness one: a shared scheduler sweeping every source in one pass has no natural place to hold
  a per-source concurrent-write guard, so the duplicate-loop and lease-token mechanisms above would
  need to be reinvented against a shared table rather than falling out of "one execution owns one
  source."
- **A single containment check (lexical only).** Rejected because it is exactly the check a symlink
  defeats — see the containment section above. A `realpath`-only check was also considered and
  rejected: `realpath` requires the target to exist, so a lexical check has to run first regardless,
  to reject an absolute path or textual traversal attempt before ever touching the filesystem to
  resolve a real path for something that may not even be there.
- **Aborting a sweep on the first file failure.** Rejected for the reasons in the per-file-failure
  section — a recurring, unattended loop cannot afford an all-or-nothing posture where one bad file
  in a large folder blocks every other file indefinitely.
- **A single size check against the connector's stat only.** Rejected because a stat taken at list
  time is a snapshot, not a guarantee about what `fetchFile` will actually return; trusting it alone
  would let a file that grows between the two calls slip an oversized read past the cap the codebase
  otherwise enforces everywhere else a file's bytes are handled.

## Known bounds

1. **The duplicate-loop guard is best-effort, not the correctness control.** `isWorkflowRunning`
   fails open to "not running" on any lookup error, so a transient engine hiccup could in principle
   let `requestSync` start a second execution alongside one still genuinely running. This is
   acceptable only because `syncLeaseToken`'s compare-and-set is what actually prevents two
   concurrent attempts from corrupting each other's `fileStates` write — the workflow-id guard is a
   convenience against an obviously redundant `sync now` click, not a substitute for the lease.
2. **A lost lease discards that attempt's work entirely, including files it successfully synced.**
   `finalizeSync`'s compare-and-set is all-or-nothing per sweep: an attempt that synced 900 of 1000
   files and then lost its lease to a newer attempt persists none of those 900 — they are re-synced
   by whichever attempt does finalize. Acceptable because a lost attempt implies a newer one is
   already running the same sweep, so the work is not lost, only redone.
3. **Containment is a filesystem-only concern.** `LocalFolderSourceConnector` is the only
   implementation `SOURCE_CONNECTOR` currently binds. A future connector reading from an external
   API has a different trust boundary entirely — request signing, response size limits, and
   pagination — and containment as specified here does not generalize to it; the interface's two
   methods generalize, the containment mechanism does not.
4. **The per-file failure-open posture means a persistently broken file produces a persistently
   stale entry.** A file that fails every sweep keeps its previous `SourceFileState` watermark
   forever (deliberately — advancing the watermark on a failed attempt would make the cheap
   size/mtime check skip the file on every future sweep without it ever having synced). Nothing
   currently surfaces "this file has failed N sweeps in a row" beyond the per-file `lastError`
   string a caller has to know to look at.

## Consequences

**Good.** A new connector kind is additive — bind a second `SOURCE_CONNECTOR` implementation behind
`Source.kind`, and neither the workflow, the service, nor the duplicate-loop/lease-token guards
change. The lease-token discipline is proven code, not new invention: it is the same two-part
pattern `IngestionService.ingestVersion` already uses, applied to a recurring loop instead of a
once-and-done job, so its failure modes are already understood.

**Costs.** Two independent guards (workflow-id check, lease token) covering two different failure
classes is more moving parts than a single mechanism would be, and a reader has to understand both
to see why neither alone is sufficient. The double size check reads, at a glance, as a redundant
line — it is not, but the staleness argument that justifies it is not visible from the code itself
without this document.

**Deferred, deliberately.** Per-file failure visibility (bound 4) is not surfaced anywhere beyond
the raw `lastError` string on each file's state entry — there is no "N consecutive failures" signal,
no alerting, and no automatic backoff for a file that will never succeed. A remote-API connector's
very different trust and rate-limit boundary (bound 3) was not designed here; only the local
filesystem case was.

## Interview framing

> The core decision is that a source's sync loop needed two different kinds of protection, not one:
> a cheap check against starting an obviously redundant second loop, and a real compare-and-set
> lease that is what actually stops two concurrent attempts from corrupting each other's writes if
> the cheap check ever lied. I kept those separate on purpose, because collapsing them into one
> mechanism would have meant the fast path — checking whether a workflow is still running — also had
> to be the correctness guarantee, and that check fails open by design; it has to, because a
> transient lookup failure against the workflow engine is not a reason to refuse a sync. What I'd
> flag before anyone else does: the connector is a provider, not a service, specifically because it
> reads bytes from somewhere this process doesn't control — same reasoning as every other external
> boundary in this codebase — and the path-containment check does two passes, lexical then
> `realpath`, because a symlink inside an otherwise-safe root defeats a lexical-only check and a
> permission boundary that can't prove containment has to refuse, not guess. And the size cap being
> checked twice isn't redundancy — the connector's stat is a snapshot that can go stale between list
> and fetch, so the check against the bytes actually read is the one that's authoritative.

## Related

- `docs/adr/0003-temporal-from-day-one.md` — the durable-wait argument this ADR applies a third time,
  to a recurring sync loop instead of an answer pipeline or an approval gate.
- `docs/adr/0006-model-access-behind-a-decorated-provider.md` — the port-behind-a-token pattern
  `SOURCE_CONNECTOR` follows.
- `docs/adr/0009-durable-human-approval-gates.md` — the two-part lease discipline this ADR's
  `syncLeaseToken` mirrors, and the general "durable wait, not a hand-rolled state machine" argument.
