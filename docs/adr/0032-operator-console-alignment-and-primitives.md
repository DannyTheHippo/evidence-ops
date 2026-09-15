# ADR-0032 — Operator console: alignment contracts, primitives and the vocabularies pages share

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** `docs/adr/0026-design-system-and-form-architecture.md`
- **Supersedes:** nothing

## Context

ADR-0026 gave the SPA a kit and one form architecture. It did not give the pages a shared geometry.
A route-by-route audit of the operator console (Wave 0, written observations per route) found the same
defects repeating across areas. Filter controls sat on different baselines. `(optional)` suffixes
wrapped onto their own line. Table rows grew to fit their content. Page headers split their actions
across flex children. Truncated text was disclosed only through `title=`. The sidebar's group headings
were `<h2>` elements that preceded every page `<h1>`. Each page also invented its own words for
connection state, its own page size and its own overlay.

The fix ran as one cycle. First came three foundation units: the kit and stylesheet system, the shell
and data layer, and the API. Then eight page areas: Home, Sources, Data room, Ledger (with measures and
entities), Adjudication, Answers, Runs, and Admin and identity. A close-out step then settled the
defects the areas surfaced. The areas ran in parallel and never saw each other's work. The only thing
keeping them consistent was a set of written contracts. This ADR records those contracts as they
were built, where that differs from how they were first written.

## Decision

### 1. Four alignment contracts, each pinned by a styles-contract case

Each contract is enforced in `web/src/test/styles-contract.test.ts`. The CSS lives in
`web/src/styles/primitives.css` unless a different sheet is named.

| contract | rule | pinned by |
| --- | --- | --- |
| Toolbar | Up to two rows below the page head, each rendering only while its slot is present. The view row holds the view switch at its start and the result count pushed to the far edge, both vertically centred. The filter row holds `FilterBar`: a flex row that wraps its controls to their shared bottom edge, with the sort select and Clear filters last. `.segmented-control` carries no margin of its own — the toolbar's own row gap already spaces it. Field widths are minimums, so a select sizes to its longest option: `.field--sm\|md\|lg` set `min-width`, and `.field--grow` lets a free-text control fill the remaining width. No toolbar rule targets a `.hint`. Format help goes in the placeholder plus a visually hidden `aria-describedby` element. | `pins the toolbar contract`: no selector combines `.toolbar` with `.hint`; `.filter-bar` has `display: flex`, `flex-wrap: wrap` and `align-items: flex-end`, and no `grid-template-columns`; `.toolbar-row--view` has `align-items: center`; `.segmented-control` carries no `margin`. `pins the form grid`: `.field--sm\|md\|lg` read `min-width: var(--control-w-*)`; `.field--grow` reads `flex: 1 1 var(--control-w-md)` and `max-width: var(--control-w-lg)` |
| Form grid | The legacy `.form label` flex-column rule is gone. That rule wrapped every `(optional)` suffix and stacked radio dots. A `width` or `min-width` inside a `.field*` selector reads `var(--control-w-sm\|md\|lg)` or `100%`. `Field` takes `width?: 'sm' \| 'md' \| 'lg' \| 'grow' \| 'full'`, default `'full'`. | `pins the form grid`: `.form label` exists in no sheet; every `.field*` width reads a token or `100%`, with a floor of three occurrences. Resting control borders read `var(--control-line)`, pinned separately by `pins the control boundary token`. |
| Table row | A body cell on desktop has a fixed height, `.grid tbody td` reading `var(--row-h)`; Sources, Data room and Runs keep some cells two lines deliberately rather than shrinking them further. Truncated cell text is wrapped in `Tooltip`, with a non-hover path to the full value — the row's detail view, its `Drawer` or a `CopyButton`; `.cell-truncate-action` keeps a truncated value and its inline icon action on one line regardless of the truncation. A `<colgroup>` fixes every named column's width (`.col-narrow` through `.col-badge`, plus the narrower `.col-tiny`, `.col-thin`, `.col-slim` and `.col-snug`) and leaves the one column with no `<col>` to absorb whatever width remains; a page's own `min-width` on `.grid` floors that at the fixed columns' width plus 16rem. Below 768px, `.grid:has(td[data-label])` restacks each row into a labelled card, and its `td` reads `height: auto` with a `min-height: var(--row-h)` floor in place of the fixed desktop height. | `pins the table row contract`: `.grid tbody td` height is `var(--row-h)`; no rule whose selector contains `.grid` sets a bare-px height |
| Page head | `.page-head` is a grid (in `views.css`). `PageHeader` always wraps its actions in `.page-head-actions`, so a caller's fragment cannot produce extra grid children. Its `<h1>` carries `tabIndex={-1}` as the route-change focus target. `.stat-row` is a grid, but its column template is not pinned: its auto-fit template keeps four stats from pairing into alternating wide and narrow rows. | `pins the page head grid`: `.page-head` `display: grid`, `.page-head-actions` exists, `.stat-row` `display: grid`. `.eyebrow` and `.micro-label` reading `var(--tracking-caps)` is pinned by `pins the caps register`. |

Filters apply as they change: a select, a checkbox and a date preset apply on change, and free text
applies 300 ms after the last keystroke or on Enter. An invalid text value neither applies nor moves
focus. Each settled change gets one polite result-count announcement.

Date presets read the URL key `range=24h|7d|30d|custom`, resolved to instants only at request time.
`24h` is rolling. `7d` and `30d` are whole local days including today. Custom uses local midnight
with an exclusive upper bound. A legacy `from`/`to` link with no `range` still reads as custom, and a
date that is not a real calendar date reads as unset. Inside `DateRange`, each date input keeps its own local draft and commits only a complete calendar
date with a year of at least 1000, so a browser's intermediate `type="date"` value while a year is
still being typed never round-trips through the URL as an empty field; an inverted range is never
emitted, and its ordering error lands on whichever field's edit caused the inversion.

Every other URL-backed list value is read defensively the same way (`web/src/lib/paging.ts`): `sort`
and `sortDir` are narrowed against the page's own option list (`pickOption`), and `limit` and `skip`
are clamped to the page's page-size options and a non-negative integer (`clampPageSize`,
`clampSkip`), so a hand-edited or stale URL falls back to the page's default instead of reaching the
API with a value its `@IsIn`/`@Min` decorator refuses.

### 2. Sidebar groups and labels

`web/src/components/shell/Sidebar.tsx` builds five groups. Home stands alone. Every other item sits
under a heading.

| group | heading | items |
| --- | --- | --- |
| 1 | none | Home |
| 2 | Estate | Sources, Data room |
| 3 | Ledger | Ledger, Measures, Entities (admin) |
| 4 | Work | Adjudication, Answers, Runs |
| 5 | Admin | People (admin), Audit events (admin), API keys |

A member sees the Admin heading with API keys alone under it. A heading is a labelled
`<div className="sidebar-heading micro-label">` that its `<ul>` references through
`aria-labelledby`. It is not an `<h2>`, because the sidebar's grouping is not part of the page's heading
outline; that outline starts at the routed page's `<h1>`. Routes are unchanged. `NAV_LABELS` carries the
same labels for the topbar's breadcrumb fallback. The persistent sidebar and the sub-768px `Drawer`
render one nav-group source.

### 3. Primitives and what they replace

Every file below exists under `web/src/components/ui/` (or `components/shell/` for `ThemeMenu`). What
each one replaces is read against the tree at `b594439`, the last commit before this cycle.

| primitive | replaces | where |
| --- | --- | --- |
| `Alert` | Hand-written `.notice` blocks and `<p className="error" role="alert">` | Page- and form-level failures, for example `RecordListPage`, `LoginPage` and the adjudication cases. `rejected` renders `role="alert"`, every other tone `role="status"`. Never a `useFormSubmit` field error (ADR-0026). |
| `Announcer` | Nothing: the app had no persistent live region | Mounted once in `App.tsx` beside `Toaster`. It must be passed the `announce` store's subscribe and unsubscribe, or it announces nothing. |
| `Checkbox` | No predecessor | The Sources "Failed only" filter |
| `Combobox` | No predecessor | The composer's Entity filter in `AnswerComposer` |
| `DateRange` | No predecessor: no list had a date filter | Runs, Answers, Audit events, as one dropdown over `range=24h\|7d\|30d\|custom` with a From/To reveal for custom. The calendar-date-to-instant conversion is `toDateRangeInstants` in `web/src/lib/date-range.ts`, resolved at request time in the operator's local midnight, with an exclusive upper bound. |
| `Drawer` | The sidebar's hand-built sub-768px navigation drawer | Mobile navigation, the ledger cell detail, the data-room document detail |
| `FileInput` | The native `<input type="file">` in the data-room upload and Home's replace-version dialog | `DocumentList` and `HomePage`'s replace-version upload |
| `Popover` (`Menu` rebased) | `Menu`'s own positioned `.menu-surface` chrome | `Menu`, its only consumer. `.menu-surface` no longer carries its own background or shadow. Positioned through CSS anchor positioning where the browser supports it, with `position-try-fallbacks` flipping the surface on the block axis, the inline axis, or both when the preferred side would overflow the viewport; where anchor positioning is unsupported, a measured `position: fixed` box does the same flip and re-measures on scroll and resize while open, so a surface whose trigger scrolled — a People table row menu, for one — is never left at a coordinate the trigger has already moved away from. |
| `SearchInput` | Plain `Input` controls used for text search | Sources, Audit events, the document workbench's evidence reader |
| `Tooltip` | `title=` on truncated cell text and on icon-rail links | Table cells across the areas, the sidebar rail, `ConflictValueCompare`. It renders through a portal, so its text never joins an enclosing link's accessible name. |
| `ThemeMenu` | `ThemeToggle`, a cycling button, now deleted | `Topbar` and the signed-out `AuthCanvas`; three options (System, Light, Dark) on `Menu` |
| `Pager` page-size select and jump | Each page's hardcoded `PAGE_SIZE` constant (20 on some pages, 25 on others) | Every paged list. Previous and Next use `aria-disabled` with a no-op guard, not `disabled`, so paging to the end never drops focus. |
| `Button` `busy` / `busyLabel` | `disabled={pending}` plus a hand-swapped label | `ConfirmDialog`, login, invite and page actions. A busy button stays focusable and enabled and guards its own `onClick`. |
| `use-modal-dialog` | The open, close and focus-restore effect written inline in `Dialog` | `Dialog` and `Drawer`, both native `<dialog>` with `showModal()` |

### 4. Shell and data vocabularies

- **Connection state.** `web/src/lib/use-event-stream.ts` exports `CONNECTION_LABELS`, a label and
  a next-action detail for each of the six `StreamState` values. Beside it sits `CONNECTION_TONES`,
  which maps each state to a dot tone: `fallback` reads as `polling`, and `idle` has no tone, so no dot
  renders. `ConnectionStatus` and `AnswerWorkspace` read both. The tone map lives in the lib, not in a
  component file, because a component file cannot export a constant under
  `react-refresh/only-export-components`. No page maps a non-`fallback` state to "live".
- **`announce(message)`** (`web/src/lib/announce.ts`) is a module-scope publish/subscribe store with
  the same shape as `toast.ts`. On each navigation the shell focuses the page `<h1>` and announces
  the route's label once, before a detail page's data-dependent breadcrumb arrives.
- **`useAbortableEffect(effect, deps)`** (`web/src/lib/use-latest.ts`) hands the effect an
  `isCurrent()` sequence guard, so a response for a superseded run is dropped and never rendered.
  List and detail fetches use it. It was chosen over threading an `AbortSignal` through `client.ts`,
  which would change every exported fetch signature for the same guarantee.
- **`invalidatePendingCounts()`** (`web/src/lib/use-pending-counts.ts`) makes the sidebar and
  Adjudication badges refetch after a decision. One shared engine, re-synced on every pathname, auth
  or signed-in-user change, serves every mounted `usePendingCounts()` caller, so the counts already
  on screen survive a route change until the refetch resolves rather than blanking, and a sign-out or
  a user switch clears them at once. It also refetches when the document becomes visible. A count is
  decoration: a failed fetch resolves that count to `null` and the badge disappears. It never blocks.
- **Session probe.** `ensureSession()` in `web/src/lib/auth.ts` **fails closed per call**. Only a
  definite 401 from `GET /auth/me` caches anonymous. Any other rejection, whether a network error or
  a non-401 status, resolves to `null` for that call and leaves the cache unprobed. The next call
  therefore probes again instead of trusting a guess drawn from a transport failure. Concurrent
  callers share one in-flight probe.

### 5. Page size: `limit` = 25, options `[25, 50, 100]`

Every paged list keeps its page size in the URL under the key `limit`, defaults to 25, and offers
`[25, 50, 100]`. `Pager`'s own default options are `[25, 50, 100]`. A page whose URL carries a second
list names that list's key separately. This supersedes the `[20, 50, 100]` default the cycle's
cross-wave contract first declared for `Pager`.

`limit` was chosen over `pageSize` because it is the query parameter the API already takes. The URL
and the request therefore use the same word. It was also the key most pages already used. 25 was the
value most lists already shipped. Neither key had shipped in a commit, so no legacy `?pageSize=` alias
is kept. 100 is the API's `MAX_PAGINATION_LIMIT`. The rejected alternative, `pageSize`, is the more
descriptive word, but it would have churned more pages and diverged from the API's name.

### 6. API additions

- **`lastSync` on source responses.** `SourceResponseDto.lastSync` is a nested
  `SourceLastSyncResponseDto`, absent until a source has synced. The flat `lastSyncAt`,
  `lastSyncStatus` and `lastSyncError` fields are retained, because the Sources, source detail and Home
  pages all read them. `SourceResponseDto` does not mark them deprecated. `lastSync` is the read new
  code should use, and removing the flat fields would need a deprecation step first.
- **Run terminal status.** A `recordWorkflowRunEnd` activity writes `status`, `errorMessage` and
  `outcome` onto the `workflow_runs` row through `WorkflowRunsService.recordEnd`. All four workflows
  record it. `answer-question`, `ingest-document-version` and `resolve-conflict` wrap their body in
  `withRunRecording` (`src/workflows/run-recording.ts`). `sync-source` calls
  `recordRunEndSafely` directly at its loop's two terminal exits instead, because its
  `continueAsNew` iteration is not the single exit `withRunRecording` wraps. Both paths **fail open**
  through `recordRunEndSafely`: the run row is a projection write for display, so a rejection — after
  the activity's own retries are spent — is logged at `warn` with the error's cause and swallowed,
  never failing an otherwise-successful or otherwise-failed workflow.
- **Run `outcome`.** `WorkflowRunOutcome` is `resolved | rejected | timed_out`, the vocabulary
  `resolveConflict` already returns. It is optional on the schema and on `WorkflowRunResponseDto`, and
  absent on every run type except `resolve-conflict`.
- **Undated period.** The ledger facts lookup accepts the `undated` sentinel directly instead of
  parsing it into an unrelated period key, because the cell response already emits that literal.
- **Owner clearing.** On `PATCH /sources/:id`, an absent `owner` leaves it unchanged, `owner: null`
  clears it with `$unset`, and `owner: ''` is still a 400.
- **Rotating an expired key** is a 409 (`ApiKeyExpiredException`). An unknown or foreign id is still
  a 404. The gate fails closed, since it is a credential path.
- **`from` / `to`** on audit events, workflow runs and answers filter `createdAt` and are optional.
  `IsIsoInstant` refuses everything but an ISO-8601 instant in extended calendar form with a date, a
  time and an explicit offset (`Z` or `±hh:mm`) — the form `toISOString()` emits — including a day
  past its month's end. `to` must be after `from` (`IsAfter('from')`).
- **`limit` ≤ 100 is unchanged.** `MAX_PAGINATION_LIMIT` was already 100, so the change was the SPA's
  page size, not the API.
- **`workflowId` on `GET /approvals`** lets the run page's fallback poll match its stream's scope
  instead of reading the first page of the whole tenant inbox.
- **`WORKFLOW_RUN_TYPES` widened** to include `answer-question` and `ingest-document-version`.
  `rescan-conflicts` stays in the union for historical rows only.
- **A run row at every workflow start.** `QaService`, `DocumentsService`, `ConflictsService` and
  `SourcesService` each create the `workflow_runs` row when they start their workflow. The question and
  upload paths fail open: the workflow has already started, so a failed projection write is logged and
  the request still succeeds.
- **Admin self-removal is a 409 refused before any write.** `UsersService.remove` compares the target
  id with the caller's id as ObjectIds. On a match it throws `SelfRemovalException` (409, a sibling of
  `LastAdminException`) after the id-validity check and before a session opens. There is no transaction,
  no database call and **no audit record**; `LastAdminException` remains the only audited refusal. The
  refusal fails closed and applies however many other admins the tenant has. The DELETE route
  documents both 409 examples (last admin, self) under `usersApiExamples.removeConflict`. The
  rejected alternative, 403, would collide with `RolesGuard`'s 403 for a non-admin caller.

**Residual gap, stated rather than hidden.** A Temporal-level termination or workflow timeout never
runs the workflow's own recording code, so that run's row stays `running`. A workflow that ends before
its row is created has the same effect, because `recordEnd` finds no row and only logs.
`WorkflowRunsService.findById`'s live-engine refresh remains the fallback for a single run.

### 7. `features.css` is organised by area section

`web/src/styles/features.css` holds one banner section per area, contiguous, in this order: `Shared`,
`Home`, `Sources`, `Data room`, `Ledger, measures & entities`, `Answers`, `Runs`,
`Admin & identity`. Adjudication has no section of its own; its blocks live under `Shared`. A banner
names its area and topic in the file's box-drawing style, `/* ── <Area>: <topic> ─…─ */`, and never a
wave or work-unit id. A block whose classes have consumers in two areas belongs to `Shared`. The file
has one writer at a time.

During parallel page work, each area appended its own section and edited nothing above it. That
append-only mode made concurrent writers safe. It also leaves duplicate selectors and out-of-order
sections, so a sweep that merges, renames and reorders is priced into any cycle that uses it. This
cycle's sweep renames and re-homes the wave-id banners the append-only phase left. It also merges the
duplicate selectors that source order was resolving.

## Declined and deferred

| item | reason |
| --- | --- |
| Tabs | Declined at the design interview; not built |
| Keyboard shortcuts | Declined; no global key is bound, and `/` stays free |
| Command palette or quick-switcher | Declined |
| Row selection and bulk actions | Declined; `Checkbox` is for standalone booleans only |
| `Switch` | Built, then removed; no boolean setting or filter needed one (`Checkbox` serves the Sources "Failed only" filter) |
| Bulk endpoints | Declined, with row selection |
| Virtualised table | Declined; every list is server-paged at 25 to 100 rows, so nothing renders enough rows to need it |
| Recents list | Declined |
| Scroll memory | Declined |
| Invite-only sign-up | Out of scope for this cycle |
| A new visual direction | Out of scope; the cycle aligns the existing register |
| Webfonts | Out of scope |
| Runtime dependencies | None added; every primitive is built on native elements |
| Automated accessibility audit | Not run. The browser DevTools tooling launches its own Chrome, which is never signed in, so it cannot reach an authenticated route. Accessibility is verified by the keyboard walk plus Testing Library assertions. |
| Unit symbols in formatted values | Declined. Unit ids carry no symbol or display metadata (`MeasureUnit` is `{ id, toCanonicalFactor }`), so the formatter appends the unit id (`54,500,000 usd`). Mapping ids to symbols is a unit-registry feature, not a formatting fix. |
| Screen-reader pass | The operator's to run; see the ADR-0026 WATCH below |
| Link Home's failed-sync figure to `/sources?failed=1` | Deferred; the filtered list exists, and the link is a follow-up |
| Workflow-id lookup input on the runs list | Deferred to a later cycle |
| Runs-list liveness | Deferred to a later cycle |
| Deep link from a run to its audit events | Deferred to a later cycle |
| Subject and requested-by columns on the runs list | Deferred to a later cycle |
| Retry or terminate a run from its detail page | Deferred to a later cycle |
| Time-to-timeout on pending approvals | Deferred; `ApprovalResponseDto` exposes no `timeoutAt` |
| Link from a conflict to its ledger cell and gating run | Deferred; `ConflictResponseDto` carries neither id |
| Filter decisions by subject type, requester or entity text | Deferred; `ListApprovalsRequestDto` has no such filters |
| Per-conflict decision history | Deferred; no endpoint returns a conflict's prior decisions |
| Live refresh of the pending adjudication queue | Deferred; badge counts already refresh through `invalidatePendingCounts()` |
| An explicit undated period filter on the ledger cells list | Deferred; the cells filter still parses `period`, so it needs its own API change |
| Entity picker from `GET /ledger/entities` | Deferred; blocked on an API affordance or a kit component |
| Editing units and authority order in the measure editor | Deferred; same |
| Name search on the entities registry | Deferred; same |
| Measures sort | Deferred; same |
| Human-friendly staleness window | Deferred; same |
| Per-row proposed-alias badge | Deferred; same |
| Read-only entities view for members | Deferred; same |

## Verification

`checks:web` (`lint:check`, `typecheck`, `test`, `build`) is 0: 136 files, 1,833 tests. `checks:ci`
is 0: 221 API unit suites, 5,126 tests at 100% service coverage, plus 22 e2e suites, 497 tests.
`test:integration` last ran before the API's final fix round (unit tests went from 5,119 to 5,126
after it); at that point it passed its 4 suites, 11 of 11 tests, against a live
`mongodb-atlas-local` container.

The 18 signed-in routes (Home; Sources and source detail; the data room, document detail and
version workbench; Ledger, Measures and Entities; Adjudication; Answers, answer detail and
verification detail; Runs and run detail; People, Audit events, API keys) were each measured as a
DOM audit in a hidden, signed-in browser pane, in dark and light theme at 1440×900 and 375×812, so
this walk carries no screenshots for them. Every route showed exactly one focused `h1`, a matching
document title and breadcrumb, no horizontal page scroll, and no clipped control at 1440; list pages
showed the pager defaulting to 25 with no Apply button. The two signed-out routes, `/login` and
`/invite`, were walked with screenshots in an isolated browser at 1440 wide and at 500 wide (that
tool's narrow floor, not 375). Keyboard-only flows confirmed from this walk: `/login`'s tab order, its
theme menu, and its empty-submit inline errors; `/invite` with no token; Adjudication's request
resolution and, on a fresh approval, its reject, both with focus landing on the page heading;
run detail's approve on a fresh run, with focus on the heading and the run reading resolved;
the workbench evidence reader's `?chunk=` deep link, which focuses and scrolls to the matching
chunk; People's revoke-invitation flow, with focus landing on the revoked row; the entities
registry's **Add entity** dialog, opened and cancelled with focus returned to the opener; the
off-page `?selected=` deep link on both adjudication views; and the page-head dialogs on Sources
and People, both vertically centred with focus moved inside and restored to the opener on cancel.

The item 11 upload check passed: staging two files and pressing Enter once on **Upload** sent
exactly two `POST /api/v1/documents` requests, both 201, with one list refresh and no console
error.

The first pass across all 20 routes found five defects, fixed and re-reviewed over four rounds, the
last approved by the operator past the loop cap. The four-variant matrix walk above then found five
more layout and focus defects, fixed over three further rounds, the third past the two-round cap by
operator decision. Across both sets, ten findings were fixed, none refuted and none declined. Later
rounds' re-walks covered the 18-route sweep in dark at 1440 and light at 375 plus the changed items
in all four variants; the round immediately after the matrix walk re-walked only the items it
changed, not the full sweep.

Investigating load-sensitive test failures surfaced a tooltip open/close race: a pointer or focus
event landing between a render commit and its effect re-run was dropped. It took two fixes; after
the second, a pointer leaving within about two milliseconds of the open delay firing — before that
render commits — now still closes the tooltip. The load-sensitive test class itself was fixed by
moving its assertions onto state committed inside a transition rather than the transition's start.
One gap remains: a pointer that reaches the tooltip surface before its listeners attach, within a
sub-frame window.

Three routes were verified only in an empty state: the verification detail not-found page (no
verification exists), the entities registry (no alias group exists, exercised through the **Add
entity** cancel flow), and the proposals queue (no proposal exists). The `/invite?token=` preview
was not walked. The API keys revoke-focus fix is code-verified only — confirmed by reading
`ApiKeysPage.tsx`, not re-walked, because re-walking it needs minting a new key. The truncated
Ask-composer example chips and the truncated `SegmentedControl` labels at 375 carry no tooltip;
their accessible name is the untruncated text.

## Visual baseline

No before-screenshots survive. The browser extension's save-to-disk produced no readable file, and
the session scratch directory that held the capture attempt was later purged. The only record of the
console before this cycle is the Wave 0 written observations, per route. The after-set is kept
outside the repository with the cycle's plan files. No image comparison between before and after was
made, and none is claimed.

## ADR-0026 WATCH

The focus-as-announcement WATCH in ADR-0026 remains **Open**, and its resolution condition is
unchanged. This cycle ran no screen reader. ADR-0026 states the condition as:

> It is **confirmed** by one pass through the migrated forms with a real screen reader, on a form of
> each shape: summary-bearing, direct-focus, and form-error-only.

`Alert` does not weaken that bet: it carries form-level and page-level failures only, never a field
error.

## Consequences

**A slow UI now fails its test later.** `web/src/test/setup.ts` raises Testing Library's
`asyncUtilTimeout` from the 1000 ms default to 3000 ms. The suite runs each file in its own worker
thread, and under that CPU contention a mocked async resolution can cross a one-second window without
anything being wrong. The cost is that a genuinely slow render now takes three seconds to fail rather
than one.

**`openapi:check` remains outside `checks:ci`.** This cycle changed response DTOs and regenerated
`web/src/api/openapi.json` and `web/src/api/schema.ts` with `openapi:generate`, but a later DTO change with no
regeneration still passes the CI gate. The drift surfaces on the next regeneration, as ADR-0023 records.

**The alignment contracts bind future pages.** A new list, form or page head that does not follow them
fails `styles-contract.test.ts`. Only the declarations named above are pinned, though. A page that
invents its own layout class outside those selectors is caught by review, not by the test.

## Related

- `docs/adr/0026-design-system-and-form-architecture.md` — the kit and form architecture this amends,
  and the WATCH that stays open
- `docs/adr/0023-spa-types-generated-from-openapi.md` — the generated response types these API
  additions flow through
- `docs/adr/0003-temporal-from-day-one.md` — the determinism fence the run-recording activity respects
- `docs/adr/0017-stream-lifecycle-and-throttle-keying.md` — the stream lifecycle the connection
  vocabulary describes
