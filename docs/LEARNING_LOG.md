# Learning Log

One entry per capability as it lands. Each entry follows the same shape: the concept, the
architectural trade-off, the decision taken and why, how it was validated, and a short
interview-ready framing. Entries are appended, never rewritten — a decision that later proves
wrong gets a follow-up entry, not an edit.

Architecture Decision Records live alongside in [`docs/adr/`](./adr/).

---

## 001 — Foundations: fork, harden, and prove the gate

**ADR:** [0001](./adr/0001-fork-and-harden-a-starter-template.md)

**Concept.** Before any AI capability exists, the boring layer has to be trustworthy: typed
configuration, a real serialization boundary, deny-by-default auth, request-scoped logging, and a
validation gate that fails when something is wrong.

**Trade-off.** Scaffolding fresh is honest but slow; forking a starter is fast but inherits an
unaudited defect surface. The deciding question is not "which is cleaner" but "which defects am I
willing to be surprised by later".

**Decision.** Fork, then harden everything before feature work, and sync the fixes upstream so the
starter improves permanently. RBAC deliberately excluded — it is platform work, not template work.

**Validation.** `npm run checks` green in both repositories: 39 unit tests, 7 e2e tests against a
real MongoDB, plus the web lane.

**What I actually learned.** Three defects were invisible to code review and only appeared when the
tests ran:

- *A blank string is not an absent value.* `JWT_SECRET=""` survived `z.string().optional()` and
  `?? default`, reaching the JWT signer as an empty secret. The existing test asserted "does not
  throw" rather than the resulting value, so it passed against a broken config. Fixed at the schema
  edge so the whole class dies, not the instance.
- *`AsyncLocalStorage` does not follow a lazy Mongoose `Query`.* Execution starts at `.then()`, after
  the ALS scope has closed. I proved this with an isolated probe instead of guessing which of the
  plugin or the test was wrong — it was the test.
- *Whoever spawns a process owns stopping it.* An in-memory replica set was started and its handle
  discarded, so every test run ended in a forced exit.

**Interview framing.** "The most useful thing I did before writing any AI code was run the tests I'd
just written. Three bugs only exist at runtime — a blank env var that isn't null, an async-context
boundary that a lazy query slips past, and a leaked child process. None of them are visible in a
diff."

---

## 002 — Retrieval substrate: verifying the claim before designing on it

**ADR:** 0002 (pending — finalised with the hybrid retrieval implementation)

**Concept.** Hybrid retrieval combines lexical (BM25) and dense-vector ranking. MongoDB's
`$rankFusion` does reciprocal-rank fusion server-side; the alternative is running two queries and
fusing in application code.

**Trade-off.** A single store means one consistency model, one set of filters, and provenance living
next to the vectors — but only if the deployment genuinely supports fusing a `$vectorSearch` stage,
which is a newer capability than `$rankFusion` itself. Betting the architecture on a documented
feature without running it is how a demo dies the week it matters.

**Decision.** Single-store MongoDB, gated on a day-one go/no-go probe, with an application-side RRF
fallback behind a config flag so the design survives a "no".

**Validation.** The probe was written to reject *both* wrong answers, which is the part worth
copying: a `$rankFusion` over a collection with no search indexes errors even where it is supported
(false no-go), and a `$rankFusion` whose inputs are only `$search` succeeds on older servers (false
go). So the probe builds both index types, waits until each reports queryable, then fuses a `$search`
pipeline with a `$vectorSearch` pipeline, and runs a `$search`-only control to attribute any failure
correctly.

Result: server 8.3.4, fusion works, weights honoured, per-pipeline rank and score exposed via
`scoreDetails`, and the server's own description string confirms `sum(weight × 1/(60 + rank))` —
k=60, which the application-side fallback now mirrors for parity.

**Interview framing.** "I didn't take the docs' word for it. The probe was designed to fail loudly in
both directions — the false no-go and the false go are different bugs, and a smoke test that can't
tell them apart isn't evidence."

---

## 004 — Provenance: ground truth is code, and untested ground truth is just confidence

**ADR:** [0008](./adr/0008-locator-provenance-and-extractor-versioning.md)

**Concept.** A citation is only worth something if it resolves to the right span — and keeps
resolving after a parser upgrade, a re-ingest, or a chunking change.

**Trade-off.** Parse coarsely and subdivide later (cheap, but a locator you never captured cannot
be recovered) versus parse at the finest addressable unit and group upward (more elements, but the
provenance exists). Chose the latter. `extractorVersion` goes on every locator rather than only on
the chunk, because a citation carries only the locator — without it, a shifted offset resolves to
*something*, silently.

**Decision changed by evidence.** The plan named mammoth for DOCX. It is an HTML renderer with no
stable paragraph index and no machine-readable heading path — structurally incapable of what a
`docx-paragraph` locator is. Reading `word/document.xml` directly instead.

**Validation.** Parsers assert against a generated manifest rather than hardcoded values, so the
fixtures and the tests cannot drift apart independently.

**What I actually learned — the best bug of the project so far.** The fixture generator wrote its
page footer inside the bottom margin. pdfkit treats writing below the margin as overflow and starts
a new page, so every footer landed alone on a fresh page: the memo had 8 physical pages while the
manifest recorded 4, and the seeded conflict sat on page 3 recorded as page 2.

Nothing failed. Generation succeeded, the manifest was self-consistent, the dataset validated
against it, the suite was green — and every PDF citation in the ground truth pointed at a blank
page. Retrieval would have looked fine while the grounding gate rejected correct answers.

Two holes let it through, both now closed: the generator's page guard counted `addFooter()` calls
(intent) rather than `pageAdded` events (output), and the dataset test asserted that a locator
*existed in the manifest* rather than that it *pointed at the expected text*.

**Interview framing.** "Ground truth is code. If it isn't tested against the artifact it describes,
it's a confident assertion. My fixture generator and my eval dataset agreed with each other
perfectly and were both wrong about the document."

**Follow-through.** Closing it needed a structural change, not just a fix: the dataset had no
ground-truth *answer*, only locators and an expected outcome — so even a correct locator check
could not have caught a wrong answer, and the eval harness would have been able to score retrieval
and abstention but never correctness. Cases now carry `expectedAnswerContains`, and a resolver
parses the real fixtures with the same parsers ingestion uses.

I then checked that the new assertion can fail, rather than trusting a first-time pass: cell `F2`
resolves to exactly `"5.25%"` (not the whole sheet), a fabricated needle is not found, and `6.10%`
is found on page 2 but not page 1 — so resolution is genuinely page-scoped rather than a
document-wide search. A verification that has never been observed failing is not yet a
verification.

---

## 003 — Evidence changes the design: three plan revisions

**Concept.** Research before implementation is only useful if it is allowed to overturn decisions
already written down.

**What changed, and why.**

- *Structured output.* The plan specified forced tool-use to constrain the model to the answer
  schema. Native structured outputs (`output_format`) are now generally available and
  grammar-constrain generation directly, which is what the answer contract actually needs — a final
  JSON object matching a discriminated union, not a tool call. Switched; forced tool use stays only
  where a call genuinely chains tools.
- *DOCX parsing.* The plan named `mammoth`. It is an HTML renderer: `extractRawText` discards
  structure and `convertToHtml` exposes no stable paragraph index or heading path — which is exactly
  what a `docx-paragraph` locator is. Replaced with a direct `word/document.xml` walk.
- *Node version.* The plan said pin to 24. The repository already targeted 26 in its Dockerfile and
  `@types/node`, and the development machine runs 26. Pinning to 24 would have excluded the
  developer's own runtime to satisfy a number written before the evidence was in.

**Interview framing.** "A plan is a hypothesis. Three of mine were wrong within a day — one because
a vendor shipped a better mechanism, one because I'd named a library that can't express the thing I
needed, and one because I wrote a version number before checking what the repo already used. The
useful discipline is recording *why* each changed, so the reversal is auditable."
