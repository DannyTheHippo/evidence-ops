# ADR-0030 — Attestation bundles, MCP evidence submission, and ledger-first answering

- **Status:** Accepted — `AttestationService` (`src/features/evidence/attestations/`),
  `EvidenceSubmissionService` (`src/features/evidence/sources/evidence-submission.service.ts`),
  `submit_evidence`/`lookup_fact`/`get_attestation` (`src/mcp/mcp-tools.ts`), and
  `LedgerAnswerService`/`QuestionResolverService` (`src/features/evidence/qa/`) are all implemented
- **Date:** 2026-09-08
- **Supersedes:** —

## Context

Three gaps remained on the MCP surface after ADR-0020. A caller with a completed answer or a
verification run had no way to export a portable record of it — every result lived only behind an
authenticated `GET`, re-fetchable but not independently checkable once handed to a third party. A
caller with bytes to contribute had no write path into the corpus at all — `submit_evidence` did not
exist, so an AI client that discovered evidence in the course of its own work could only describe it
in prose, never hand over the file. And every question, however mechanically simple, paid for a full
retrieval-plus-synthesis round trip through the model even when the fact ledger (Phase 1) already held
a single confirmed, unconflicted value for exactly the cell being asked about.

This ADR covers all three, plus the tenant-wide content-dedupe invariant Phase 3A introduced, which
closes a bound ADR-0007 left open.

## Decision

### Attestation bundles: integrity, not authenticity

`AttestationService.exportForAnswer`/`exportForVerification` build a JSON bundle — subject identity,
every surviving and dropped claim with its citations and check results, ledger decisions behind those
citations, and the confirmed/proposed/rejected measures cited chunks belong to — and hash it:
`integrity.contentHash = sha256(canonicalJson(bundle without integrity))`
(`attestation.service.ts:218`, `canonical-json.util.ts`). `canonicalJson` sorts object keys at every
depth, so the hash is stable across two calls that produce the same content in a different key order,
and rebuilding every citation field by explicit scalar read (`buildCitations`, `:321-333`) rather than
passing a Mongoose document through keeps `_id`/`__v`/timestamps out of what gets hashed.

**There is no signing key.** The hash is computed and returned by the same process that holds the
data — it proves the bundle has not changed since export, to a recipient who already has that exact
hash through some channel they trust, and nothing more. It does not prove who produced the bundle,
and it does not let a recipient who received only the bundle (no hash, out of band) verify anything at
all: they would need the hash from a separate, trusted channel to check against. A signature would
additionally prove authorship; building one was out of scope for this cycle, and every description of
this feature — the tool's own MCP-facing text (`getAttestationToolDefinition`, `mcp-tools.ts:458-462`)
included — says "hash, not a signature" rather than implying more.

`producedAt` is the subject's own `createdAt`, not the moment of export — a `Verification` row and an
`Answer` row are both immutable once written (`answerModel.findOneAndUpdate` never touches
`questionText`/`outcome`/`claims`), so two exports of the same subject produce byte-identical canonical
JSON and therefore the identical hash. That is what makes **fetching a bundle a first export**:
`attestationHash` is pinned onto the subject's own row the first time `exportForAnswer`/
`exportForVerification` runs (`{ attestationHash: { $exists: false } }` in the `findOneAndUpdate`
filter, `:220-223`, `:282-285`) and never overwritten. The row, not the export call, is the record of
"this subject has been attested" — a second export of the same subject reruns the identical hash
rather than minting a new one, so `attestationHash` on the row and `integrity.contentHash` in every
bundle ever exported for it agree.

### `submit_evidence`: REST-upload parity, no approval gate

`EvidenceSubmissionService.submit` runs an MCP caller's base64 bytes through the identical
content-identity gate a browser upload runs through: `resolveUploadKind`/`contentMatchesDeclaredKind`
against the actual decoded bytes, never the declared `mimeType` alone, then the same
`DocumentsService.uploadVersion` dedupe-by-sha256 path (`evidence-submission.service.ts:87-114`). The
size cap (`SUBMIT_EVIDENCE_MAX_BASE64_CHARS`, 20 MiB of base64 text) is checked before `Buffer.from`
ever runs (`:79`, `assertBase64Shape`), so an oversized payload is refused without paying for the
decode — and the transport layer backs that same intent: `express.json({ limit: MCP_JSON_BODY_LIMIT })`
(21 MiB, `mcp.constant.ts:37`) sits behind `createMcpPreBodyGate`, which runs the PAT authentication
and the pre-auth IP rate limit *before* `express.json` ever buffers a byte (`mcp-http-app.ts:47-56`) —
an unauthenticated or over-budget caller never costs this process any allocation proportional to body
size.

The tool is floored at `UserRole.Member` (`MCP_SUBMIT_STEP`, `mcp-tools.ts:51-54`), the same role
`search_evidence`/`get_answer` require, and it is not withheld by the spend gate
(`SPEND_GATED_TOOL_DEFINITIONS` only covers `ask_evidence`/`verify_claims` — this tool calls no
model). Every submitted file lands under a dedicated `mcp-submit` source
(`findOrCreateSubmitSource`, `:149-184`), a `SourceKind` that `CONNECTOR_SOURCE_KINDS` excludes: `POST
/sources` refuses to create one directly, and `SourcesService.runSync`'s kind guard means the sync
connector never iterates one — an `mcp-submit` source exists only to be written to by this tool,
never synced or created through the REST path.

**No approval gate.** The alternative considered — forcing `requireApproval: true` for every
`submit_evidence` call, so a human reviews a submission before it enters the corpus — was rejected in
favor of matching what `DocumentsController.upload` already does for a member-accessible browser
upload: no per-file approval today, member role sufficient. Adding one only for the MCP path would
treat an AI client's submission as more suspect than the identical bytes uploaded by a signed-in
member through the SPA, for content that goes through the same magic-byte check, the same dedupe, and
the same asynchronous extraction pipeline either way. See § Known bounds and residual §16 below for
what this bet costs.

A thrown `SubmissionTooLargeException` (413), `InvalidBase64ContentException` (400),
`ContentTypeMismatchException`/`UnsupportedContentTypeException`/`UnresolvableContentTypeException`
(400), or `SubmitSourceKindConflictException` (409) reaches the calling AI client as a typed,
readable refusal — `McpServerService`'s handler-throw branch surfaces any `HttpException` with status
`< 500` as `${error.name}: ${error.message}` (`mcp-server.service.ts:557-568`) rather than collapsing
it to the fixed generic error text every unclassified throw gets.

### Ledger-first answering: deterministic when it can be, synthesis otherwise

`QuestionResolverService.resolve` (pure, no model call) attempts to pin a question to exactly one
`(entity, measure, period)` cell using the same whole-token entity matching, alias-aware measure
matching, and period parsing the rest of this codebase already has (`resolveQuestionEntity`,
`containsNormalizedToken`, `findStatedPeriods`) — any ambiguity anywhere in that chain resolves to
`unresolved` with a named reason (`no-entity`, `ambiguous-measure`, `numeric-constraint`, and so on),
never to a guessed cell. `LedgerAnswerService.resolve` only proceeds past a `resolved` `QuestionResolution`
if `LedgerService`'s own cell lookup lands on a `single` or `adjudicated` state with a citable fact
behind it; every other fork — `conflicted`, `unknown`, a fact with no locator this codebase's citation
schema can express — also falls to `unresolved` (`ledger-answer.service.ts`'s own doc comment: "every
fork fails CLOSED toward `unresolved`").

**Gate uniformity, not a shortcut around the gate.** `answer-question.workflow.ts` runs a
ledger-resolved `AnswerContract` through the identical `groundingCheck` activity a synthesized one
runs through before either is persisted (`:157`, "the ledger path is not exempt from the gate") — the
only thing skipped is the model call and the retrieval that would have fed it, never the verification
step. A completed answer's `answerPath` field (`'ledger'` or `'synthesis'`, additive on `Answer`)
records which path produced it, and `answeredOutcomeSchema`'s new optional `ledger` field carries the
`LedgerDecision` behind a ledger-resolved answer's citation, when one exists — additive to
`AnswerContract`, not a new outcome kind, so every existing consumer of `answered` still works
unchanged.

### The tenant-wide dedupe invariant closes a bound ADR-0007 left open

Before Phase 3A, `Document`/`DocumentVersion` had no cross-document content-identity constraint within
a tenant: two genuinely distinct `Document` rows could carry the same sha256, and `computeChunkId`
(`compute-chunk-id.ts`) folds only `tenantId` — not `documentId` — into a chunk's derived id, precisely
so re-ingesting identical bytes for the same tenant reproduces the same chunk ids for the eval replay
cache. ADR-0007's Known bound 6 named the gap this left open: "two genuinely distinct documents within
the same tenant that happen to produce byte-identical content still collide."

Phase 3A's `document_versions_tenantId_sha256_unique` index and `Document.locations` array
(`migrations/0001-baseline.ts:287`) make that scenario structurally unreachable rather than merely
detected: byte-identical content within one tenant is now always the same `Document` row, carrying one
`DocumentLocation` entry per place it was found, never two distinct documents sharing a hash. Three
rules keep that invariant intact as locations come and go:

1. **Divergence.** `addVersion` onto a document with more than one location forgets the caller's
   location and starts a fresh document with the new bytes — a copy whose content changes is no
   longer a copy of anything, so it stops being represented as one.
2. **Withdrawal.** `runSync` forgets an absent path's location first and withdraws the version only
   when no location remains — a document known from three places losing one is not the same event as
   the same document losing its last place.
3. **Email attachments.** An attachment's location carries `emailOrigin`, and the same idempotency
   check that prevents a duplicate `Document` for a re-processed email widens to look across both
   `emailOrigin` on the location and on the top-level field, so an attachment identical to a plain
   upload dedupes into the one document either path would have produced alone.

`computeChunkId`'s own bound is unchanged by this — the hash still scopes by tenant, not by document,
and `documentId` still isn't folded in, for the replay-property reason ADR-0007 already gives. What
closes is the *scenario* the bound described: this invariant guarantees no two `Document` rows in one
tenant ever hold the same sha256 to begin with, so the collision ADR-0007 flagged as open cannot occur
against current code, independent of whether the hash formula itself changes later.

## Known bounds

1. **Verification bundles carry no decisions.** `AttestationBundle.decisions` is always `[]` for a
   `kind: 'verification'` export — Phase 2's `Verification` row shape (`{ claims, results, atoms?,
   requestedBy, usage, createdAt, tenantId }`) carries no conflict ids to look decisions up from, so
   `exportForVerification` has nothing to populate that field with. An `Answer` export's `decisions`
   is populated from its own `conflictIds` plus any ledger-decision conflict its outcome names.
2. **Measures come from cited chunks only.** `buildMeasures` derives the bundle's `measures` array
   from `ExtractedFact` rows found on the chunks a survived or dropped claim actually cites — a
   measure relevant to the question but never cited by a surviving claim (for instance, one behind a
   dropped claim with no citations at all) is absent from the bundle, not a defect in the lookup.
3. **The `mcp-remote` bridge configuration is unverified if 3B.15's implementer could not verify it
   against current client documentation.** The README's Claude Desktop and Cowork setup steps for
   this surface's eight tools are contingent on that verification; see 3B.15's own record for whether
   it held.

## Consequences

**Good.** An answer or a verification run can be handed to a third party as a self-contained,
tamper-evident record, checkable against a hash obtained separately, without re-authenticating to this
system. An AI client can contribute evidence it discovers mid-task directly into the corpus it is
already reasoning over, through the same content-identity gate every other ingress runs through. A
question the ledger can already answer deterministically no longer pays for a model call, a
retrieval round trip, or the citation-fabrication surface a synthesized answer necessarily carries —
while still clearing the identical grounding gate before it is ever persisted.

**Costs.** `submit_evidence` widens who can write into the corpus: a PAT-holding AI client, not only a
signed-in member using the SPA, can now add a document a human never looked at before it entered
retrieval. The mitigations are the same gate every other ingress already clears — magic-byte
verification, dedupe, asynchronous extraction — not a stronger one built for this path specifically.
`AttestationService`'s hash is integrity-only; a bundle recipient who did not separately obtain the
hash from a channel they trust cannot verify anything about a bundle handed to them out of band, and a
future increment that wants authenticity needs a signing key this cycle deliberately does not build.

**Deferred, deliberately.** A signing key (and the key-management burden it brings) for
`AttestationBundle`; a fact-id-carrying read tool that would let `request_resolution` be called from
nothing but MCP-reachable data, the same gap ADR-0014 named and left open; per-token scoping narrower
than the step-level role floor `submit_evidence` and the other seven tools share today.

## Related

- `docs/adr/0004-grounding-gate-and-citation-contract.md` — the gate `answer-question.workflow.ts`
  runs a ledger-resolved outcome through identically to a synthesized one.
- `docs/adr/0005-deterministic-authz-and-tool-chokepoint.md` — the chokepoint `MCP_SUBMIT_STEP` and
  the other MCP steps route every tool call through, `submit_evidence` included.
- `docs/adr/0007-eval-replay-cache.md` — **amended by this ADR's dedupe-invariant section**: Known
  bound 6's same-tenant/two-distinct-document collision cannot occur against current code now that
  `document_versions_tenantId_sha256_unique` makes it structurally unreachable.
- `docs/adr/0009-durable-human-approval-gates.md` — the two-key control `submit_evidence`
  deliberately does not invoke; a write this permitted still never becomes a decision.
- `docs/adr/0014-mcp-server-surface.md` — **amended by this ADR.** The advertised tool count and the
  `MCP_SUBMIT_STEP`/`MCP_READ_STEP` shape both grow; see that ADR's own inline amendment note.
- `docs/adr/0020-attestation-surface.md` — **amended by this ADR.** `verify_claims` already produced
  a per-claim verdict; this ADR is what makes a `Verification` row's record of that durable and
  independently exportable, the same way a completed `Answer` now is.
- `docs/adr/0021-evidence-lifecycle-and-withdrawal.md` — the withdrawal path the dedupe invariant's
  second rule composes with; a location's absence and a version's withdrawal are the same soft-delete
  primitive this ADR's divergence/withdrawal rules build on.
- `docs/global/threat-model.md` — residual §16 states the bound on a PAT-holding AI client writing
  bytes into the corpus, and the paragraph on the attestation hash being integrity without
  authenticity.
