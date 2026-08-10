# ADR-0008 — Locator provenance, extractor versioning, and fixtures as testable ground truth

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** —

## Context

A citation is only worth something if it resolves. "Page 4 of the memo" has to actually be page 4,
and it has to still be page 4 after a parser upgrade, a re-ingest, or a chunking change. That makes
the extraction layer a provenance problem, not a text-extraction problem.

## Decision

### One parser contract, format-specific locators

Every parser emits the same `ParsedElement` — sanitized text plus a locator — so chunking never
learns which format a span came from. The locator is a discriminated union: `pdf-page`,
`docx-paragraph` (index plus heading path), `xlsx-region`, `xlsx-cell`.

Elements are emitted at the **finest** granularity the format can address (a page, a paragraph, a
cell). Chunking then groups upward. The reverse — parsing coarsely and subdividing later — cannot
recover a locator that was never captured.

### `extractorVersion` on every locator, not just the chunk

A citation carries only its locator. If a parser upgrade shifts page or paragraph offsets, a
citation that cannot state which extractor produced its coordinates is not verifiable — it will
resolve to *something*, quietly, and that something may be the wrong span. Stamping the version on
the locator makes the mismatch detectable instead of silent.

### mammoth rejected for DOCX

The plan named mammoth. It is an HTML renderer: `extractRawText` discards structure entirely, and
`convertToHtml` exposes no stable paragraph index and no machine-readable heading path — which is
exactly what a `docx-paragraph` locator *is*. Reading `word/document.xml` directly and walking
`<w:p>` in document order gives a stable index, and `<w:pStyle>` ancestry gives the heading trail.

The general lesson: a library chosen for "extracts text from X" may be structurally incapable of the
addressability the citation model requires, and that is not visible from its README.

### Spreadsheets emit what a reader sees

A percentage-formatted cell stores `0.0525` and displays `5.25%`. Conflict detection compares
figures across a spreadsheet and prose, and the prose says "5.25%". Emitting the raw fraction would
make a genuine agreement look like a conflict and vice versa, so the parser applies the cell's
number format.

### Untrusted input, failing closed

OOXML is zip plus XML, so both parsers face XXE, zip bombs and zip-slip. The archive guard is shared
by both rather than duplicated — the copy that does not get a fix is the one an attacker finds.
DOCX rejects a `DOCTYPE` outright rather than merely disabling external entities, because an
internal subset can define entities that expand at parse time without fetching anything.

The size guard's limit is stated rather than glossed: it reads the sizes the archive *declares*, so
a crafted file can under-report them. The real bound is the upload endpoint's cap on the compressed
payload. It is a cheap first filter, not a decompression-bomb proof.

## The failure that shaped this: ground truth must itself be tested

The eval dataset keys its expectations to locators in a generated manifest. The fixture generator
wrote a page footer at `height - 50` — inside the 72pt bottom margin — and pdfkit treats writing
below the margin as content overflow and starts a new page. Every footer therefore landed alone on
a page of its own.

The result: `valuation-memo.pdf` had **8 physical pages** (content on 1, 3, 5, 7) while the manifest
recorded **4**. The seeded conflict sat on physical page 3 and was recorded as page 2.

Nothing failed. Generation succeeded, the manifest was self-consistent, the dataset validated
against it, and the whole suite was green — while every PDF citation in the ground truth pointed at
a blank page. Retrieval would have looked fine and the grounding gate would have rejected correct
answers.

Two things allowed it, and both are now closed:

1. **The generator's page guard counted intent, not output.** It counted `addFooter()` calls, which
   were 4, rather than rendered pages, which were 8. It now counts `pageAdded` events. Note pdfkit
   creates the first page inside its constructor, before any listener can attach — so `autoFirstPage`
   is off and every page is added explicitly, rather than compensating with an off-by-one.
2. **The dataset test asserted locators *existed* in the manifest, not that they were *true*.** A
   locator must be checked against the document it points into, not against the record that claims
   what the document contains.

## Consequences

**Good.** Citations resolve to a real page, paragraph or cell, and a parser change that would move
them is detectable rather than silent. Fixtures are byte-deterministic across machines and
timezones, so the committed corpus is a checkable artifact rather than a snapshot of one laptop.

**Costs.** Reading `word/document.xml` by hand is more code than calling mammoth, and it will need
extending for tables and lists. Per-cell elements make a spreadsheet a large number of elements,
which chunking must group sensibly.

**Known limitation, stated rather than hidden.** The PDF bounding box is the union of every text
item on the page, so it covers nearly the whole printable area. It is honest as "this page has
content" and useless as a UI highlight. **Page-level citation is the real contract today**; a usable
highlight needs a finer locator granularity than one element per page.

## Interview framing

> The interesting bug wasn't in the parser. The fixture generator was silently emitting a blank page
> after every content page, so the ground truth said page 2 and the file said page 3 — and
> everything was green, because the generator's guard counted footer calls instead of rendered
> pages, and the dataset test only checked that a locator existed in the manifest rather than that
> it pointed at the right text. Ground truth is code. If it isn't tested against the artifact it
> describes, it's just a confident assertion.
