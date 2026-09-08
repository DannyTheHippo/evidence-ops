# ADR-0029 — The HTML parser bounds nesting depth, before parse5 runs

- **Status:** Accepted — implemented as `HTML_MAX_NESTING_DEPTH` in
  `src/features/evidence/ingestion/parsers/html.parser.ts`, verified by measurement (§ Result)
- **Date:** 2026-09-07
- **Amends:** nothing. It adds a fourth fail-closed bound to the parser introduced in phase 3A.

## Context

`HtmlParser` shipped with three fail-closed bounds: a byte cap (`HTML_MAX_BYTES`, 20 MiB), an element
budget (`HTML_MAX_EMITTED_ELEMENTS`, 20,000) and a refusal for unterminated raw-text elements. None
of them bounds parsing cost, and the plan's own acceptance criterion for the step asserted the
opposite of a bound: *"nested `<div>` 50,000 deep parses without stack overflow"*. The spec written
to that criterion carried a 60-second jest timeout and a comment recording that the case cost 13–23
seconds of CPU — the expense was observed, and accepted, as the price of proving the tree walk is
iterative rather than recursive.

`parse5`'s parse cost grows quadratically in nesting depth while staying linear in tag count. At
identical tag counts and comparable byte sizes:

| shape | 10,000 tags | 25,000 | 50,000 | 100,000 |
| --- | --- | --- | --- | --- |
| nested `<div>` | 452 ms | 3,626 ms | 35,716 ms | 140,279 ms |
| flat `<p>x</p>` | 9 ms | 29 ms | 30 ms | 65 ms |

A 2.1 MiB document of 200,000 nested `<div>` cost 189 seconds end to end — longer than the
`extractFacts` activity's own five-minute `startToCloseTimeout`, so a hostile upload a fraction of
the byte cap would time out, retry, and occupy worker capacity for as long as the retry policy
allowed. Extrapolated to the 20 MiB byte cap the same shape runs for hours.

**The element budget cannot bound this, and moving it does not help.** `checkElementBudget` is
counted during this parser's own tree walk, and that walk begins only once `parseHtml` has returned.
Splitting the cost confirms where it lives: at 100,000 levels `parse5` spends 100,336 ms and the
subsequent walk over all 100,005 nodes spends **7 ms**. Any budget checked during the walk — whether
counted at element open or at element close — is evaluated after the expense has already been paid.

## Decision

**Bound nesting depth on the decoded text, before `parse5` is called.** `HTML_MAX_NESTING_DEPTH` is
1,000; `checkNestingDepth` runs between `decodeTextBuffer` and `parseHtml` and refuses past it with
`MalformedHtmlException`, the same non-retryable exception the parser's other bounds raise.

The scan is a deliberate over-approximation of the depth `parse5` will build, not a tokenizer. It
reads no raw-text or RCDATA state, and knows nothing of auto-closing, so a run of sibling `<p>` or
`<li>` counts as ever-deeper nesting and tags written inside a `<script>` body count at all. Both
err toward refusing. What the guard needs is a floor on `parse5`'s depth, never an over-estimate of
it; the one place it reads lower is the wrappers `parse5` inserts on its own (a `<tbody>` in every
table), which costs one level per nested table against a bound with three orders of magnitude of
headroom.

Three properties the scan must have, each closing a bypass:

- **`/>` is not honoured.** Outside foreign content HTML has no self-closing syntax, so `<div/>`
  opens a `div`. A scanner that read the slash as a close would report depth 0 for a document
  `parse5` nests 100,000 levels deep.
- **The 13 void elements are excluded.** They never close, so counting them as opens would refuse an
  ordinary page carrying a few thousand `<br>` or `<img>`. This is the one direction where
  over-counting harms legitimate documents.
- **The running balance clamps at zero.** Otherwise a thousand `</div>` in a comment bank credit
  against a thousand real levels of nesting that follow them.

The regular expression uses only simple, non-nested quantifiers: a guard against a super-linear
parse must not itself backtrack on hostile input.

`HTML_MAX_EMITTED_ELEMENTS` stays, unchanged in value and counted at element open. It bounds this
parser's output and the downstream chunking cost of one document — which is what it was always for.
It is no longer described as bounding the cost of opening an element, because it does not.

### Rejected: moving the element budget to element close

Counting an ordinary block only once its text is known to be non-empty lets the 50,000-deep document
parse, which satisfies the plan's acceptance criterion. It leaves the quadratic fully reachable, and
it makes the budget's own doc comment false. Rejected on the measurement above.

### Rejected: lowering `HTML_MAX_BYTES`

Depth, not size, is the driver. A 1 MiB document already costs 100 seconds, so the byte cap would
have to fall to roughly 100 KiB to bound the same behaviour — refusing the large, flat, legitimate
documents this parser exists to read.

## Result

Measured against the same documents, through the full parser:

| depth | before | after |
| --- | --- | --- |
| 50,000 | parsed, ~35 s | refused, 8.2 ms |
| 100,000 | parsed, ~140 s | refused, 11.3 ms |
| 200,000 | parsed, ~189 s | refused, 22.8 ms |

Parsing a document at exactly the bound costs 6.8 ms. Real HTML nests tens of levels deep.

The parser spec's deep-nesting case now asserts refusal rather than a successful parse, keeps a
companion case at exactly the bound to prove the walk is still iterative, and covers each of the
three scan properties above. Its 60-second timeout is gone; the file runs in 8.8 s where it
previously took over 35 s.

## Consequences

- A document nested past 1,000 levels is refused at ingest with a 400-class exception and no retry.
  No legitimate corpus document is known to approach this; if one is found, the bound moves, and the
  cost of the new bound is measured before it does.
- The bound is a floor on `parse5`'s depth, not an exact count. A document refused at the boundary
  may nest slightly less than 1,000 levels in the tree `parse5` would have built. This is stated in
  `checkNestingDepth`'s own doc comment.
- The plan's acceptance criterion for step 3A.5 is not met as written, deliberately. The criterion
  asserted a behaviour that is a denial-of-service; the deviation and its evidence are recorded here
  and in the step's own note.
- Both the implementing agent and the orchestrator first placed this cost in the wrong layer — the
  agent by moving the element budget, the orchestrator by restoring it — and each fix would have
  shipped the quadratic untouched. The split measurement (`parse5` 100,336 ms vs walk 7 ms) is what
  settled it. A guard that runs after the expensive call cannot bound the expensive call.

## Amendment, 2026-09-08 — the bound was calibrated on the wrong shape

The public-corpus fetch (Phase 5) put 235 real SEC filings through this parser and **`corpus:size`
failed on the first one**. `HTML_MAX_NESTING_DEPTH` was 1,000; measured against the corpus, that
refuses **123 of 235 filings (52%)**.

The error was in the proxy, not the intent. `checkNestingDepth` counts cumulative unclosed opens,
and knows nothing of implicit closing — so a table-heavy filing whose `<td>`, `<tr>` and `<p>` close
implicitly scores far higher here than it costs `parse5` to build. The two shapes diverge by more
than an order of magnitude at the same scanned depth:

| document | scanned depth | size | parse time |
| --- | --- | --- | --- |
| synthetic single chain of nested `<div>` | 50,000 | 0.5 MiB | ~35,000 ms |
| Welltower 10-K (`well-20241231.htm`) | 50,629 | 15 MiB | **652 ms** |
| Welltower 10-K (`well-20231231.htm`) | 46,683 | 15 MiB | 661 ms |
| Alexandria 10-K (`are-20231231.htm`) | 25,122 | 6 MiB | 247 ms |

Corpus depth distribution: median 1,178, p90 12,767, max 50,629.

**The bound is now 60,000**, sitting above the real corpus maximum and below the point where a
degenerate chain would approach the `extractFacts` activity timeout. The guard still refuses the
shape it exists to refuse; it no longer refuses half of the real documents this system is for.

The original bound was derived entirely from synthetic probes. That is the failure this cycle was
commissioned to fix, reproduced in miniature: a number measured against documents we authored
ourselves, wrong the first time it met documents we did not.
