# ADR-0022 — Lexical alignment hardening: polarity, proportional overlap, script refusal, word numbers

- **Status:** Accepted — implemented in `check-quote-alignment.ts` and `extract-numeric-tokens.ts`,
  covered by `test/features/evidence/qa/check-quote-alignment.spec.ts` and
  `test/features/evidence/qa/extract-numeric-tokens.spec.ts`
- **Date:** 2026-08-25
- **Supersedes:** —
- **Amends:** narrows `docs/adr/0004-grounding-gate-and-citation-contract.md`'s Known bound 2 (see
  § What this narrows)

## Context

`checkQuoteAlignment` (ADR-0004's check 3) and `extractNumericTokens` (check 4) are both lexical
checks by design — token overlap and digit-pattern matching, never comprehension. That design choice
was sound; four specific implementations of it were not, and all four shared the same shape: the check
computed a real signal and then accepted on a threshold too weak, a token class too coarse, or a
vocabulary too narrow to mean what its passing result implied.

1. **Polarity was never checked.** Two shared content words was enough to align a claim with its
   quote, and `not` is not a stopword — so a claim that flatly negates the fact its own quote states
   ("...was not renovated" against a quote reading "...was renovated") shared every other word and
   passed, with `not` itself doing nothing to weaken the match (it only helps if both sides happen to
   contain it).
2. **The shared-token floor was a constant, not a function of what it was measuring.** Two shared
   words is a defensible floor for a short claim — `MIN_SHARED_CONTENT_TOKENS`'s own doc comment gives
   the legitimate-heavy-paraphrase case that floor exists to protect — but it is trivial to clear for a
   long statement, where two incidental shared words say nothing about whether the statement as a
   whole is actually the quote's subject.
3. **The non-ASCII exemption assumed every non-ASCII script tokenizes the way Cyrillic does.** Cyrillic,
   Greek, Hebrew, Arabic, and Hangul all separate words with whitespace, so the existing
   `\p{L}`/`\p{N}` split already produces real word-level tokens for them, and exempting those tokens
   from the (English-tuned) length floor and stopword list is correct. Han, Hiragana, and Katakana do
   not use whitespace between words at all — an unpunctuated clause in Chinese or Japanese collapses
   into a single oversized token, and the same exemption that is correct for Cyrillic instead lets that
   one coarse token stand in for word-level overlap it structurally cannot provide.
4. **`extractNumericTokens` was digit-pattern-only, and the gap was silent, not visible.**
   `verify-claim.ts`'s check 4 iterates `extractNumericTokens(claim.statement)` and raises a violation
   for every value in that array it cannot support. A statement reading "six percent" produced an empty
   array — not because the claim states no number, but because this function could not read the one it
   states — and an empty array is indistinguishable, to that loop, from a claim that genuinely asserts
   nothing numeric. The claim passed check 4 with its one substantive number never verified.

Bounds 1 and 3 are new findings; bound 2 is a direct instruction from the plan step that produced this
change; bound 4 is the same gap ADR-0004's own Known bound 2 already named and left open ("a number
written in words... is invisible to it").

## Decision

### Polarity: a third gate, checked only after the other two already pass

`checkQuoteAlignment` now compares whether the statement and its quotes agree on being negated at all,
via a closed class of English negation markers (`not`, `no`, `never`, `none`, `neither`, `nor`,
`without`, `cannot`, and a generic `\w*n't\b` pattern covering every English negative contraction
without enumerating each one). `detectsNegation` is a whole-text boolean, not a per-clause one: it
answers "does either side contain a negation marker", not "which clause does it attach to". This is
deliberately still lexical, not semantic — a claim negating a *different* clause than the one its quote
actually supports still passes, and a claim using a semantic-but-not-lexical negation ("the lease
prohibits subleasing" against a quote reading "...shall not sublease...") still mismatches by this
check's own admission, since "prohibits" carries no negation marker this class recognizes. The check
exists to catch the specific, cheap attack the substance/overlap gates cannot: reusing most of a
quote's words while flipping the one word that changes what it means.

Placement matters: polarity is checked last, only once substance and overlap both already pass. A
claim that already fails overlap does not need a polarity verdict — it is already rejected — so this
ordering costs nothing and keeps the two independent axes (is this claim *about* the quote; does it
*agree* with the quote) cleanly separable in the result.

### The shared-token floor scales with the statement's own length

`SHARED_CONTENT_TOKEN_RATIO` (0.2) multiplies the statement's own word-token count (never the quotes',
never a numeric token) to produce a proportional requirement, rounded up and floored at
`MIN_SHARED_CONTENT_TOKENS` (2, unchanged). The floor is a `max`, not a replacement: every statement
this suite already covered is well under ten content words, so `ceil(wordCount * 0.2)` stays at or
below 2 for all of them and the fixed-floor behavior those tests already asserted is preserved exactly
— this is a widening for long statements, not a general tightening. A new regression test
(`check-quote-alignment.spec.ts`, "should require more shared tokens for a longer statement than the
fixed floor would have") is built the other way: a 16-content-word statement sharing 3 words with its
quote cleared the old fixed floor of 2 and now needs `ceil(16 * 0.2)` = 4, correctly failing.

0.2 is a deliberately conservative ratio, chosen empirically against this suite's existing statements
rather than derived from a formal model of what "enough" overlap means for arbitrary claim length —
the same kind of judgment call `MIN_SHARED_CONTENT_TOKENS`'s original fixed value already was.

### Script refusal, not weaker acceptance, for Han/Hiragana/Katakana

Real word-level tokenization for Chinese and Japanese text requires a segmentation dictionary or model
this repository does not have, and adding one is out of scope (`.claude/CLAUDE.md`: no new dependency
unless the task requires it — and the task here explicitly offers refusal as the alternative). Rather
than let the existing non-ASCII exemption keep degrading silently for these two scripts,
`checkQuoteAlignment` now refuses outright: `containsUnsegmentedScript` (a single `\p{Script=Han}`/
`\p{Script=Hiragana}`/`\p{Script=Katakana}` alternation, tested with the `u` flag) is checked first,
before any tokenization runs, and a match on the statement or any quote returns
`quote-script-unsupported` immediately.

**This means a verbatim-identical Han-script statement and quote — the strongest lexical match
possible — is refused, not accepted.** That is a real capability loss for genuine Chinese/Japanese
claims, and it is the deliberate trade this ADR makes: this check exists to reject weak evidence, and a
token comparison this codebase cannot honestly perform is not a basis for accepting anything, however
the match happens to look. A false rejection here costs a follow-up question; a false acceptance costs
trust in every claim this gate is supposed to be protecting.

**Cyrillic, Greek, Hebrew, Arabic, and Hangul are deliberately excluded from the refusal.** All five
separate words with whitespace or an equivalent word-spacing convention, so the existing
`\p{L}`/`\p{N}` split already produces real word-level tokens for them — refusing them would be
punishing scripts the existing exemption already serves correctly. The existing Cyrillic regression
test (`check-quote-alignment.spec.ts`, "should align a claim and quote in Cyrillic sharing enough word
tokens") still passes unchanged.

**Known bound, stated plainly rather than left implicit: Thai, Lao, Khmer, and Myanmar share the exact
same no-whitespace problem as Han/Kana and are not covered by this refusal.** This ADR closes the two
scripts the originating finding named; it does not claim to have surveyed every script without
word-spacing. A future finding against one of these scripts should extend
`UNSEGMENTED_SCRIPT_PATTERN`, not re-derive the reasoning above.

### Spelled-out cardinal numbers are normalized, not merely flagged

`extractNumericTokens` is the one place in this change where normalization was chosen over refusal, and
the choice was forced by where the two candidate fixes could actually live. `verify-claim.ts`'s check 4
is the only consumer that turns "no numeric tokens" into a silent pass, and it is out of scope for this
change (peer-scoped to a concurrent plan step). A refusal implemented only inside
`extractNumericTokens` — returning some sentinel meaning "a number was stated but not understood" —
would have nothing downstream to read it: check 4's loop already treats an empty array as "nothing to
verify" and cannot be taught otherwise without editing the file that owns it. Normalizing the
spelled-out form into the same numeric value the digit form would produce closes the gap using the
mechanism that already exists: `extractWordNumberTokens` parses standard English cardinal-number
grammar (ones/teens, tens, `hundred`/`thousand`/`million`/`billion` scaling, a trailing `point` clause
for decimals spoken digit-by-digit) and merges its matches with the digit-pattern matches in original
text order, so `verify-claim.ts`'s existing `for (const claimedNumber of extractNumericTokens(...))`
loop verifies "six percent" exactly as it already verifies "6%" — no change needed to that loop, and
none made.

**Deliberately bounded vocabulary.** Ordinals ("sixth"), fractions ("half", "a dozen"), and non-English
number words remain unrecognized — the same silent-pass gap this change closes for the cardinal-word
case, narrowed rather than eliminated. `extractNumericTokens`'s own "Known gap" doc comment states this
precisely, matching the actual coverage rather than the pre-existing, now-inaccurate blanket claim that
spelled-out numbers are simply invisible.

**A bare, unscaled "one" is deliberately dropped.** "One" is the single word in this vocabulary that is
at least as often a pronoun ("the only one", "each one") as a cardinal number, and every other word in
the vocabulary lacks that ambiguity. `extractWordNumberTokens` suppresses a run that is exactly the
single word "one" with no following scale word and no decimal point before it, while still extracting
it when scaled ("one hundred" → 100) or in a decimal clause ("point one" → the digit `1`). This is a
one-word, narrowly-scoped exception, not a general disambiguation heuristic — no other cardinal word in
the vocabulary gets this treatment, because none of them share "one"'s pronoun collision.

**A run of scale words with no `ONES`/`TENS` word anchoring it is also dropped — this is what keeps
the digit-plus-magnitude-word gap (below) from silently reopening in the word path.** "$41 million"
tokenizes the digits and the word separately, since digits are not `\p{L}`; the word scanner sees only
a bare "million" with nothing in this vocabulary in front of it. An earlier version of this change
extracted `1,000,000` from that bare word regardless, inventing a second, phantom number the statement
never actually states — `extractNumericTokens('sold for $41 million')` returned `[41, 1000000]`, not
the `[41]` the digit path alone would produce. `extractWordNumberTokens` now requires a run to contain
at least one `ONES`/`TENS` word before extracting it: "one hundred" still extracts (anchored by "one"),
"a million dollars" (no digit, no anchoring cardinal word either) now extracts nothing, matching what
this function did before it recognized word numbers at all.

**No negative numbers, matching the digit pattern's own refusal.** `NUMERIC_TOKEN_PATTERN` already
refuses a leading minus sign, documented in-file as a domain fact (real-estate metrics here are never
negative) rather than a parsing limitation. `extractWordNumberTokens` has no "negative"/"minus" entry
for the same reason: "negative six percent" still extracts `6`, dropping the sign, the identical
asymmetry the digit path already accepted before this change.

**Fail-closed by construction, not merely by intent.** Every over-triggering risk in the word-number
grammar — an incidental "point" immediately following an unrelated number, a spurious cardinal-word run
inside prose that was never meant as a quantity — produces a numeric value check 4 then tries to verify
against cited evidence. A spurious extraction that finds no support is rejected as
`numeric-claim-unsupported`, the same fail-closed outcome this gate already produces for a genuinely
unsupported number. There is no path by which a parsing false positive here causes a claim to be
accepted that should not have been; the only failure direction available is over-rejection, which is
the direction this gate's own doc comment already declares acceptable.

### Unrepresentable digits: a refusal signal, not a mapping table

`extractNumericTokens` returns only finite, representable values — a digit run it can see but cannot
turn into a verifiable value is never included in its output. `containsUnrepresentableNumber` is the
separate, explicit predicate for that case, and `verify-claim.ts`'s check 4 consults it only against a
claim's own statement, never against a cited chunk's text: a chunk's own unrepresentable numbers
contribute no support and no violation, the same as any other number a chunk simply does not
corroborate.

Two alternatives were considered and rejected before landing on a separate refusal predicate:

- **A `\p{Nd}` block mapping table** (Arabic-Indic, Devanagari, and every other Unicode decimal-digit
  block, each mapped to its ASCII equivalent). Rejected: any script the table omits silently
  reintroduces the exact defect this predicate exists to close, for whichever block was missed — the
  table is a maintenance surface with no mechanism to fail loudly when it falls behind Unicode's own
  digit-block additions.
- **An in-band `NaN` sentinel** inside `extractNumericTokens`'s returned `number[]`, meaning "a number
  was stated but not understood." Implemented, then reverted: a `NaN` in that array collides with every
  other unparseable value once `check-quote-alignment.ts`'s stringify-then-compare token tagging is
  applied to it (`` `#${NaN}` === `#${NaN}` `` is `true` under `SameValueZero`, even though
  `NaN !== NaN`), letting two unrelated unparseable numerals overlap as a shared content token — see
  Known bound 8 below for why that trap is a property of the stringify-then-compare pattern itself, not
  just this one sentinel.

The invariant the current design encodes: a digit run this module can see but cannot represent as a
verifiable value must never read, to a caller, as "no number stated" — regardless of *why* it cannot be
represented. Unsupported script and out-of-range magnitude are two instances of that one condition,
which is why a single predicate covers both rather than two narrower ones.

One deliberate exclusion, stated so it reads as a choice rather than a gap: a spelled-out word-number
overflow (`"nine"` followed by two hundred repetitions of `"hundred"`) is not signalled by
`containsUnrepresentableNumber`. It contains no digit run at all, and the pathological repetition that
induces the overflow is itself why nothing a reader would recognize as a stated number is present in the
first place — treating it as a silently vanished claim is the correct outcome, not a residual gap this
predicate needs to close.

## Known bounds

1. **Polarity detection is lexical, not semantic — see § Decision, Polarity.** A claim whose negation
   is expressed without one of the closed markers (a synonym like "prohibits", an implicit contrast) is
   not caught. A claim negating a clause its quote does not actually address is not caught either — the
   check only compares whether either side contains *any* negation marker, not which fact it modifies.
   The bare-word markers (`no`, `not`) also fire on non-negation uses this domain's documents routinely
   contain — "Parcel No. 12", "not to exceed" as a fixed legal phrase — which can produce a false
   polarity mismatch. This is the fail-closed direction the gate already accepts elsewhere (a false
   mismatch drops a claim that should have survived, never the reverse), not a new exposure.
2. **The proportional floor's ratio (0.2) is an empirical choice, not a derived one — see § Decision,
   The shared-token floor.** It was validated against this suite's existing statements, all short; its
   behavior on genuinely long, multi-clause claims (which this codebase does not yet generate) is
   untested in practice.
3. **Script refusal covers Han/Hiragana/Katakana only — see § Decision, Script refusal.** Thai, Lao,
   Khmer, and Myanmar share the same no-whitespace problem and are not refused; a claim or quote in one
   of those scripts still gets the (incorrect, coarse) substring-equivalent treatment the non-ASCII
   exemption always gave every script.
4. **Spelled-out number coverage is bounded to standard English cardinals — see § Decision, Spelled-out
   cardinal numbers.** Ordinals, fractions, and non-English number words remain invisible to
   `extractNumericTokens`, the same class of silent-pass gap this ADR closes for cardinals specifically.
   A digit-and-word decimal mix ("6 point five") is also not merged into `6.5` — the digit `6` and the
   spelled-out `5` are extracted as two separate values (`[6, 5]`), the same fail-closed-by-omission
   outcome as any other unrecognized construction, not a crash or a wrong single value.
5. **This alignment remains lexical, not entailment, in every dimension this ADR touches.**
   `checkQuoteAlignment`'s own doc comment states this directly: token and polarity-marker overlap can
   show that a claim and its quotes are not talking about different things and are not asserting
   opposite things, but it cannot verify that the claim's *reasoning* from the quote to its conclusion
   is sound. ADR-0004's Known bound 1 already established this for the original two gates; nothing in
   this ADR narrows that bound — the third gate added here is the same kind of check, not a different
   kind.
6. **Canonicalization and mixed-script refusal close a specific, bounded class of Unicode gaps, not
   every way a visually deceptive quote can defeat lexical matching.** `INVISIBLE_CHARACTER_PATTERN`
   strips C0/C1 controls (other than tab/LF/CR, which `normalizeQuoteText`'s whitespace collapse
   already handles), every `Cf` format character, every default-ignorable and bidi-control code point,
   every `Grapheme_Extend` combining mark, every `Zl`/`Zp` line/paragraph separator, and every `Zs`
   space separator other than plain space and no-break space (the two this codebase already treats as
   genuine word gaps, excluded via the `v`-flag set difference `[\p{Zs}--[\u0020\u00A0]]`) —
   covering these Unicode categories, not an enumerated list of specific code points, so an invisible
   character, a combining mark, or an unusual space or line/paragraph separator planted inside a word
   no longer defeats the negation-marker regex or the token splitter regardless of which one it is. This still leaves one category of zero-rendering code point
   uncovered by `INVISIBLE_CHARACTER_PATTERN` itself: a symbol whose glyph happens to be blank in every
   font (Braille Pattern Blank, U+2800, is one) strips to nothing visually but carries no Cc/Cf/
   Default_Ignorable/Bidi_Control/Grapheme_Extend/Zl/Zp/Zs property to key a category strip on — no
   Unicode property distinguishes it from the other 255 code points in its own `So` block, each of
   which raises at least one visible dot. `detectsNegation` closes this specific residual a different
   way: `squashToWordsAndAsciiPunctuation` reduces its input to letters, digits, and printable ASCII
   (U+0020 through U+007E) — a plain space, the apostrophe a contraction needs, and every ordinary
   punctuation mark, kept rather than removed, so a marker sitting directly against visible punctuation
   with no surrounding space ("not-remediated") keeps the `\b` boundary its regex needs on both sides.
   This is an allowlist, not one more category added to the strip, so a code point with no clean
   category test (Braille Pattern Blank) or a category not yet added to the strip is treated
   identically to one that is, for negation purposes — but the allowlist is deliberately wider than
   "letter, digit, space": a narrower one that also removed ordinary punctuation would merge a marker
   into an adjacent word wherever a document places one directly against it, silently costing the
   `\b` boundary the regex needs and turning "not-remediated" into an undetected "notremediated" — a
   reader-visible break masquerading as a stripped invisible one, the same failure mode this bound
   exists to prevent, reopened by an over-eager squash rather than by a missing strip. This projection
   is deliberately scoped to `detectsNegation` alone, not folded into `canonicalizeForAlignment`:
   `extractContentTokens` feeds that same canonicalized text into `extractNumericTokens`, which needs
   `$`, `,`, `.`, and `%` intact to parse a cited amount, and stripping every non-letter/non-digit
   character (rather than keeping printable ASCII) would remove all four. The token-overlap and
   substance gates therefore still see U+2800 (or any other unclassifiable symbol) as a word-splitting
   character — a quote or statement carrying one mid-word tokenizes into two fragments there, which can
   only push `checkQuoteAlignment` toward `quote-not-substantive` or `quote-unrelated-to-statement`,
   the same fail-closed direction every other gap in this ADR resolves to, never toward a false
   `aligned`. `canonicalizeForAlignment` NFKC-folds what remains
   after the strip; `containsMixedScriptToken` instead runs against `canonicalizeForScriptCheck`'s
   pre-NFKC-folded text, because NFKC maps some compatibility symbols onto letters carrying a specific
   script (U+2126 OHM SIGN → Greek omega) while leaving others carrying no script identity at all
   (U+00B5 MICRO SIGN is `Script=Common` before folding) — checking pre-fold lets a routine unit like
   "µg/m3" align without reopening the homoglyph path, since a genuine substitution (Cyrillic "о" for
   Latin "o") carries its own non-Latin script identity independent of folding either way. This ordering
   choice does not erase every case where NFKC assigns a specific script to a compatibility symbol:
   OHM SIGN itself is `Script=Greek` before folding too, so a quote using it in a unit like "kΩ" still
   refuses — pre-NFKC checking closes the gap for symbols NFKC would newly script-tag, not for symbols
   that already carried one. `containsMixedScriptToken` refuses any word combining a Latin
   letter with a letter from another script, catching the case where one letter of an otherwise-Latin
   word is swapped for a look-alike from a different script (a Cyrillic "о" standing in for Latin "o").
   Both are coarse by design and leave two classes of substitution uncaught: a word written *entirely*
   in a single non-Latin script that happens to resemble a Latin word (no script mixing within the
   token, so `containsMixedScriptToken` does not fire — it would only fail later, and only incidentally,
   if the substituted token no longer matches anything the overlap gate expects); and a same-script
   visual confusable (Latin "l" for Latin "I", digit "0" for letter "O"), which is not a script-mixing
   event at all and this gate has no mechanism to detect. Both gaps are the same shape as ADR bound 1's
   "lexical, not semantic" limitation: a purely visual or cross-script deception this codebase cannot
   see is not the same claim as a deception this gate was built to catch and missed.
7. **Grapheme-cluster boundaries are not a unit this alignment system tracks.** `isMixedScriptToken`
   walks a token by Unicode code point (`for...of` over a string, which never splits a surrogate
   pair), but a grapheme cluster spanning more than one code point — a Devanagari base-plus-virama
   sequence, an emoji ZWJ sequence — is not a single unit to that walk. Nothing in this module or in
   `locateQuote` segments text into grapheme clusters before comparing it, so a citation whose quote
   boundary happens to fall inside one is not treated specially. This is benign and fails in the same
   direction every other gap in this ADR does: a quote cut mid-cluster no longer matches its chunk's
   text byte-for-byte, so `locateQuote` reports it as a mismatch rather than an exact containment, and
   the claim it supports is dropped — never accepted on a false match.
8. **Stringification defeats a non-finite value's self-inequality — a standing hazard of the
   stringify-then-compare pattern itself, not a bug closed for good by any one fix.**
   `check-quote-alignment.ts`'s `extractContentTokens` tags a numeric token as `` `#${value}` `` before
   comparing tokens as strings. That stringification defeats `NaN`'s self-inequality:
   `` `#${NaN}` === `#${NaN}` `` is `true`, even though `NaN !== NaN`. Two unrelated unparseable
   numerals, or two corrupted facts, would collide as a shared content token and inflate overlap if a
   non-finite value ever reached that tagging step. `extractNumericTokens` never produces one (§
   Decision, Unrepresentable digits, above), so the specific path that surfaced this is closed — but the
   trap is a property of the stringify-then-compare pattern itself and re-arms for any future non-finite
   value that reaches those tokens, not only a numeric-token sentinel. The residual guard that remains
   deliberately in place: `verify-claim.ts` filters `cellFacts` to `Number.isFinite(fact.value.amount)`
   before building `corroboratedNumericTokens`, because `fact.value.amount` is stored data outside this
   module's control — a corrupted extraction could still carry a non-finite amount even though
   `extractNumericTokens` itself never returns one.
9. **NFKC normalization's side effects beyond digit folding are accepted scope, not merely a code
   comment's note.** `extractNumericTokens` NFKC-normalizes before matching, which folds full-width
   ASCII digits (the point of normalizing at all) but also folds other compatibility forms it was not
   written for — superscript digits and vulgar fractions such as `½` fold to plain digits too, so a unit
   string can incidentally extract a phantom numeric token. This is accepted: the failure direction stays
   fail-closed either way — a spuriously extracted token still has to match a real fact or chunk value to
   survive check 4, so it can only cause a claim to be dropped as unsupported, never accepted on a token
   that was never actually stated as a number.

## What this narrows

ADR-0004's Known bound 2 states: "`extractNumericTokens` matches `\$?\d[\d,]*(?:\.\d+)?%?` — a number
written in words ('six percent') is invisible to it." That sentence is now **narrowed**, not reversed:
a claim stating a standard English cardinal number in words is no longer invisible to
`extractNumericTokens` (§ Decision, Spelled-out cardinal numbers, above) and check 4 verifies it exactly
as it verifies a digit-written number. The bound's second half — "a scaled value written as `'$41
million'` parses as the number `41`, not `41,000,000`" — is **unaffected**: that sentence describes a
digit-plus-magnitude-word mix (`$41 million`), a different construction from the all-word numbers this
ADR's grammar parses (`forty one million dollars`), and the digit path still has no notion of a
trailing magnitude word. ADR-0004 itself is not edited — per this repository's convention, a prior
ADR's claim is narrowed by a new record rather than rewritten in place — this ADR is that record.

## Consequences

**Good.** Two forms of the specific attack the plan step named — a claim that negates its own cited
quote, and a claim that states its one substantive number in words rather than digits — no longer pass
grounding verification with nothing actually checked. A long statement's alignment can no longer be
established by two incidental shared words. A script this codebase cannot honestly tokenize word-by-word
no longer produces a token-overlap verdict it cannot back up.

**Costs.** A genuine Chinese- or Japanese-language claim, however well-cited, is now unconditionally
rejected by `checkQuoteAlignment` — a real capability loss, accepted because the alternative was an
unreliable accept. The word-number grammar is a nontrivial amount of new deterministic logic
(`extractWordNumberTokens`) carrying its own bounded vocabulary and its own "one" special case, both of
which need to stay documented as the vocabulary is extended, not just correct today.

**Deferred, deliberately.** Extending script refusal to Thai/Lao/Khmer/Myanmar (Known bound 3),
extending the numeral grammar to ordinals/fractions/non-English words (Known bound 4), and validating
the 0.2 ratio against genuinely long multi-clause statements once this codebase produces any (Known
bound 2) are all real follow-up work this ADR does not do.

## Related

- `docs/adr/0004-grounding-gate-and-citation-contract.md` — the ADR whose Known bound 2 this narrows
  (see § What this narrows above), and the source of the "citation verifier, not reasoning verifier"
  framing this ADR's polarity gate and script refusal both stay inside.
