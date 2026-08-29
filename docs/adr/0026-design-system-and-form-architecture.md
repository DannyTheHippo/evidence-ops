# ADR-0026 — A design system and one form architecture, instead of twenty hand-rolled forms

- **Status:** Accepted — implemented across `web/src/`, with a supporting API contract in
  `src/shared/exceptions/request-validation.exception.ts`
- **Date:** 2026-08-29
- **Amends:** ADR-0023 (SPA types generated from OpenAPI) — narrows the untyped half it records
- **Supersedes:** nothing

## Context

The SPA was functionally complete and conventionally disciplined: a shared kit, token-driven CSS, a
pinned cascade, strong test coverage. Its pages were built to be **correct**, not designed. Vital
signs rendered as prose inside a meta line; two visually identical row kinds meant different things;
a partial failure stacked four independent alerts; a loading skeleton matched no layout it stood in
for.

The forms were worse, and in a way that hid itself. Each was hand-rolled controlled state with
native constraint attributes as the only validation, no focus management after a failure, and a
copy-pasted `useRef` double-submit guard — eight of them, with comments cross-referencing each
other. Three dialog forms were `div.form` plus a click handler, so **Enter did nothing at all**; the
SPA's only `onKeyDown` handlers were in `Menu`.

Underneath that, a contract defect. The API returned class-validator's `message: string[]` on a
validation failure, and the client's error reader accepted only a `string`. Every field-level
message was dropped and the user saw a literal **"Bad Request"**. `Field` had a correctly wired
`error` prop — `role="alert"`, `aria-invalid`, `aria-describedby` — with exactly **one** consumer in
the entire app.

## Decision

Three layers, built in that order, plus the contract that makes the third possible.

**1. A structured per-field validation-error contract.** `RequestValidationException` replaces Nest's
default factory on the global `ValidationPipe`. The body keeps `statusCode`/`error`/`message` in the
shape every other 400 uses — `message` stays a single string — and adds `errors`, a per-field
breakdown. Nested and array paths flatten dot-joined (`values.0.unit`). Domain exceptions are
untouched and carry no `errors` key, which is what lets a caller distinguish the two.

`message` staying a string is deliberate: an unmigrated client immediately shows joined constraint
text instead of "Bad Request", so there is no regression window between the API and SPA changes.

**2. A system layer.** A denser token register (32px controls, tightened row rhythm, motion and
overlay-width tokens); hairline elevation, where `--shadow` is reserved for menu, dialog and toast
and a card is defined by its edge; and ten new kit components. `LinkButton` alone absorbed **14
sites** that hand-wrote `className="btn btn--secondary btn--sm"` on an anchor, because `Button`
renders a `<button>` and nothing rendered a styled link.

**3. One form architecture — `useFormSubmit`.** Hybrid validation timing: never on change, on blur
after first touch, and on submit. One internal in-flight guard replacing the eight copies. Focus
moves to an `ErrorSummary` on failure where the form has one, and to the first invalid control where
it does not.

### The binding contract, which is the part that would have failed silently

`useFormSubmit<F>` maps `ApiError.fields` onto field errors **by DTO property name**. Nine of the
thirteen input-collecting surfaces used local state names that differed from their DTO properties —
`SourceDetailPage` on all five fields, `SearchPage` on all four. Had the hook been built against the
page's own naming, every one of those forms would have compiled, passed its tests, and silently
never displayed a server field error.

Two edge cases fall out and are specified rather than discovered:

- A field with no control folds into the form-level error and is never discarded. The upload form's
  multipart `file` part is not a DTO property at all; `decision` and `winningFactId` have no control.
- An indexed path (`aliases.0`, `values.0.unit`) matches on its **root segment** where a control for
  that root exists.

### Announcement moves from `role="alert"` to focus

`Field`'s inline error drops `role="alert"` and gains a visually-hidden `Error: ` prefix. The
announcement is the focus move — to the summary, or to the invalid control whose
`aria-describedby` already points at its message. Keeping both would double-announce every failure.

### Dialog motion is enter-only, and close is instant

`Dialog` returns `null` when closed, so React unmounts the element; an exit transition needs the node
to stay in the DOM and merely lose `[open]`. The exit CSS was written, reviewed, and **discarded
before it shipped** — it could never have fired. Keeping the dialog mounted was rejected: its
children would stay in the DOM, `getByText` does not filter hidden content, and every page test
asserting dialog copy is absent-when-closed would break. `--motion-overlay-exit` stays defined and
unspent.

### Contract-test canaries take opposite rules

`styles-contract.test.ts` gained rules pinning motion durations and font families to tokens, and a
≥24px floor on the compact control. Two kinds of canary now live in that file:

- **Exact (`toBe`) — only the bare-px sweep**, where the count *is* part of the gate because
  `BARE_HEIGHT_EXEMPTIONS` is selector-scoped. A new decorative marker earns a list entry and a
  bumped count in the same change.
- **Floors everywhere else**, because there the per-declaration assertion is the gate and the count
  only guards a regex that has stopped matching. An exact count would fail every correctly-tokenized
  animation the redesign added, while the contract test sits outside the CSS agents' write scope.

The motion rule checks `transition:`/`animation:` **shorthands** as well as the longhands. Eleven of
this codebase's fourteen motion declarations are shorthands, so a longhand-only rule would have
enforced nothing while appearing to.

## How it was verified

5,413 tests green across both build roots: 957 SPA, 4,065 API unit at 100% service coverage, 391
API e2e, plus a clean production build.

Test count is not the interesting part. These behaviours were **proven rather than assumed**, each
because the obvious test would have passed without demonstrating anything:

- **`ConfirmDialog` focuses Cancel on a destructive dialog.** The component claimed this as a safe
  default and DOM order focused Confirm. `autoFocus` alone was rejected: `showModal()` runs in an
  effect and re-runs the browser's own initial-focus steps, so the fix is an explicit focus applied
  as the last statement of that same effect. The test says plainly that jsdom has no `showModal`, so
  it confirms the mechanism's result and cannot exercise the ordering against a real browser.
- **The Ask page's error toast is gone.** Asserting the page alert renders is compatible with both
  firing — which is the double-report being removed. The tests assert the toast store is empty.
- **`useSourceSync.onSettled` fires exactly once**, and never while polling — with a caller passing
  no callback unaffected, which matters because `SourcesPage` mounts one instance per row.
- **Enter submits from a name input and inserts a newline in a textarea.** jsdom implements neither
  natively, so a naively written test proves nothing in either direction.
- **An `aliases.0` server error lands on the `aliases` control**, exercising the root-segment rule
  that had no consumer when it was written.

Two claimed fixes turned out to be **already true** and were reported as such rather than
re-implemented: `CopyButton` already reset its copied state on a changed value, and the API's
throttler already set `Retry-After` from the real remaining TTL.

## Consequences

**`features.css` grew to twenty banner sections and accumulated dead rules.** Ten page waves ran
concurrently, each appending its own section rather than editing shared regions. That convention is
what made the parallelism safe — and it is what left an unreferenced `.timeline` block and a
`.value-compare` rule superseded only by source order. Swept in this change; the convention is worth
keeping with the sweep priced in.

**A response DTO reaches the SPA's generated types only if its route names it with `type:`.** An
`api-examples` entry carrying `status`, `description` and rich `examples` but no `type` documents the
route with **no schema**. Regeneration succeeds, both generated files change, `tsc` passes, and the
SPA silently keeps a hand-written interface with no drift protection. This was hit once during the
work and found by grepping `schema.ts` — never by an exit code. The success entries across every
`api-examples` file were closed in this change, narrowing the "roughly half" ADR-0023 records.

**Swagger example messages are hardcoded literals, not derived from the exception classes.** Changing
a server-side message therefore leaves the documented example stale, and regeneration will not catch
it. The examples and the exceptions have to move together by hand.

## Falsifiable signal (WATCH)

The load-bearing bet is **focus-as-announcement**. Every field error lost its `role="alert"` on the
theory that moving focus — to an `ErrorSummary`, or to a control whose `aria-describedby` names its
message — announces the failure at least as well, without the double-announcement of doing both. No
assistive technology exercised that; jsdom cannot, and no test in this repo can.

This decision is **indicted** if a screen-reader user reports a failed submit that announced nothing,
particularly on a one- or two-field form where there is no summary and the entire announcement rests
on the browser reading a focused control's description. The remedy would be a single polite live
region owned by the hook, not a return to per-field alerts.

It is **confirmed** by one pass through the migrated forms with a real screen reader, on a form of
each shape: summary-bearing, direct-focus, and form-error-only.

**Resolution:** at the first assistive-technology pass over the redesigned forms. **Status: Open.**

## Related

- `docs/adr/0023-spa-types-generated-from-openapi.md` — the generated-types boundary this narrows
- `docs/adr/0017-stream-lifecycle-and-throttle-keying.md` — why the data-room list pauses under a
  filter, which the new status line makes visible
- `docs/adr/0019-repository-inventory-beyond-synced-sources.md` — the two source lists the new
  segmented control and the server-side `q` filter both span
