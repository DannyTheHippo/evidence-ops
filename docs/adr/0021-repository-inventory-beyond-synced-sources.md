# ADR-0021 — Repository inventory beyond synced sources: connectivity, reachability, owners, and the drift a class edit leaves behind

- **Status:** Accepted
- **Date:** 2026-08-19
- **Supersedes:** —

## Context

Every `Source` in the estate has always been a connector: something the sync loop reaches into on
a schedule. A real discovery engagement finds repositories that are not that — an export drop
nobody automated, a share the client will not open a connector against, a folder someone emails
monthly. Before this milestone those repositories either did not exist in the system at all, or
were modelled as connectors that happened to sync nothing, which reads on `SourcesPage` as a broken
integration rather than a deliberate inventory entry.

`Source.sourceClass` had also been required and defaulted since it was introduced, but exposed
through no DTO and no SPA surface — write-only by accident, not by design. And `T3`'s audit
(`docs/adr/0020-tenant-invitations-and-the-real-member-role.md`) gated `POST /sources` and
`PATCH /sources/:id` to Admin without touching the SPA, deliberately, because this milestone
rebuilds `SourcesPage`/`SourceDetailPage` substantially — gating them first would have been
rewritten within hours. That left a live gap: a Member could submit the create form or click the
enable toggle and receive a 403 with no inline explanation.

## Decision

### Connectivity, reachability, owner, tracked: modelling what T3 could not gate around

`Source` gains four fields. `connectivity` (`'connector' | 'export-only' | 'manual'`) states how the
source's bytes actually reach the corpus. `reachability` (`'live' | 'possible' | 'prohibited'`)
states whether the estate's own access posture lets this system reach it at all —
`'prohibited'` is a standing policy decision an owner made, not an incident, and is never rendered
with the same alarm register as an actual failure. `owner` is a free-text person or team, **required
on create and never defaulted or backfilled** — its absence is exactly the gap an inventory pass
exists to close, and inventing a placeholder value would erase the signal that nobody has claimed
this repository yet. `tracked` (boolean, default `true`) marks whether the sync loop may ever run
for this source at all; `false` is a permanent inventory-only row, not a paused connector, and sync
scheduling skips it — a guard stated with its direction, since the alternative (silently trying and
failing to sync an export drop) would read as a broken integration on every scheduled pass.
`sourceClass` becomes settable through `UpdateSourceRequestDto` and visible on every response DTO,
closing the write-only gap.

### The SPA renders two lists, not one table with a status row

`SourcesPage` now fetches and paginates `tracked: true` and `tracked: false` sources
**independently**, each its own `<Table>` with its own `<caption>` and its own `Pager`. A single
table with a divider row was rejected: a `<td colSpan>` separator carries no accessible semantics,
so a screen-reader user hitting one would hear nothing marking the transition — exactly the
distinction this feature exists to make legible. Partitioning one fetched page client-side was
rejected for a sharper reason: the pager's `count` would be the combined total, so page 2 could
render 20 synced and 0 inventory rows with neither list's length reconciling with anything visible
on screen. `ListSourcesRequestDto` therefore declares `tracked` as a real filter — `forbidNonWhitelisted`
means an undeclared query key is a 400, so declaring it is what makes the two-list split possible at
all.

The inventory (untracked) table renders only Name, Path, Owner, Reach and Class — no interval,
status, last-sync or file count, and no per-row Enable/Sync actions, because none of that state is
meaningful for a row the sync loop never touches. `SourceRow` (the synced table) gains Owner, Reach
and Class columns onto the existing shape. Owner renders the person's name in plain, inked text, and
falls back to `Unassigned` as muted `.cell-sub` text — deliberately **not** a badge, because an
absence badged reads as a status of its own, while a single muted cell sitting in an otherwise inked
column is the gap made visible without inventing a tone for it. Reach renders as a `Badge` with
`connectivity` stacked beneath as `.cell-sub`, the same shape the existing Last-sync cell already
uses. Class renders as plain text so it never reads as a third status axis competing with the real
Status column.

### Tone map: `prohibited` is policy, not an incident

`live → verified`, `possible → caution` (the class is literally `badge--possible`), `prohibited →
neutral`. The `rejected` octagon — verification-grade failure — is deliberately never spent here;
`prohibited` means an owner decided this system should not reach a repository, which is the exact
opposite of something going wrong.

### `tracked` is a `Select`, because nothing else fits

The SPA has no checkbox anywhere and `Field` is built for text inputs, so `tracked` renders as a
two-option `Select` — `"Synced by a connector"` / `"Catalogued only"` — on both the create form and
`SourceDetailPage`'s inventory edit form, rather than introducing the SPA's first checkbox for one
field.

### `SourceDetailPage`'s Inventory card is the update form, not a separate read view

Rather than inventing read-only field-list vocabulary alongside an edit form, the Inventory card
**is** `UpdateSourceRequestDto` with pre-filled inputs — Owner, Connectivity, Reachability, Tracked
and Class — seeded from the loaded source and re-seeded whenever the source object changes (a toggle
or a class-drift apply both return a full source, so this never disagrees with an unsaved edit that
was never sent). Saving re-runs the class-drift load in the same handler, because editing `sourceClass`
here is exactly what creates drift (`docs/adr/*-drift*` — see the R3 step this milestone follows),
and a successful edit that left the drift card to appear only on the next navigation would be a
silent gap the size of the feature it just built.

### Closing the T3 carry-in: the two-flag pattern, applied where T3 could not

`SourcesPage` and `SourceDetailPage` apply `DocumentDetail.tsx`'s two-flag admin pattern verbatim:
`canManage` includes `session.status === 'authed'`, so it fails **closed** while the session probe is
in-flight rather than flashing a control at an admin who has not been confirmed yet; a separate
`sessionResolved` flag gates the explanatory notice, so an admin is never told they lack permission
while the probe is still running. `canManage` gates the create form, the Enable/Disable toggle, and
the Inventory edit form — the three controls `PATCH`/`POST /sources` actually require Admin for.
**`POST /sources/:id/sync` stays open to every role, unconditionally** — T3 left it ungated on
purpose, because it operates a source an admin already configured and dedupes against an in-flight
run, and hiding it here would contradict the boundary T3 already drew at the API.

### Home's corpus health reads the estate's own failed-only filters

`HomePage`'s corpus-health section previously fetched the newest 100 documents and sources
unfiltered and filtered client-side for a failure — a limitation the v3 frontend cycle recorded
because the query parameter it needed did not exist yet. `R1` declared `ingestionStatus` on the
documents list DTO (resolved through the document's **current** version, matching the semantics
`HomePage.tsx`'s old client-side filter already used) and `lastSyncStatus` on the sources list DTO.
`HomePage` now runs two additional, independent fetches — `listDocuments({ ingestionStatus: 'failed'
})` and `listSources({ lastSyncStatus: 'failed' })` — feeding corpus health exclusively, while the
original unfiltered fetches continue to feed only the first-run checklist and the empty-tenant
check, which need the tenant's actual corpus shape rather than its failures. A failure older than
any fixed window is now visible on Home exactly as it already was on Data Room and Sources.

## Known bounds

1. **The failed-only queries still cap at the pagination ceiling.** `limit: 100` bounds each of the
   two new Home fetches the same way the original unfiltered ones were bounded — a tenant with more
   than 100 concurrently failed documents or sources would still have some invisible on Home. This
   milestone closes the "outside the newest-100 **unfiltered** window" gap specifically; a tenant
   with that many simultaneous failures has a different, worse problem this page does not attempt to
   solve.
2. **Connectivity and reachability are not settable from the create form**, only from the
   `SourceDetailPage` edit form afterward — the create form asks only for what is required (Owner)
   and what determines which list the new row lands in (`tracked`), and leaves the server's
   `'connector'`/`'live'` defaults in place until an operator corrects them during the inventory pass.
3. **No bulk edit.** Owner, connectivity, reachability and class are edited one source at a time.
   An estate inventory pass across dozens of repositories is manual work today; batching it is not
   built.

## Consequences

**Good.** A repository nobody has automated a connector against now has somewhere to live in the
system without masquerading as a broken sync. `sourceClass` is finally visible instead of write-only
by accident. The T3 carry-in — a Member seeing controls the API already refused — is closed for
create, toggle and inventory-edit, while the deliberately ungated sync action stays reachable for
everyone, matching what T3 decided at the API. Home's corpus health no longer has a blind spot tied
to page size.

**Costs.** `SourcesPage`'s optimistic create-prepend is gone — a create now reloads whichever list
the new row's `tracked` value says it belongs to, which costs one extra round trip per create in
exchange for never showing a synced-list row that the server actually placed in inventory. Three new
required `Source` fields broke every `makeSource()`/inline fixture across `SourcesPage.test.tsx`,
`SourceDetailPage.test.tsx` and `HomePage.test.tsx` — a mechanical, `tsc`-caught pass, not a design
cost.

## Interview framing

> The two-list decision is the one worth defending, because a single table with a status column
> would have been less code. The reason it's wrong is accessibility, not aesthetics: a `<td
> colSpan>` divider row has nothing for a screen reader to announce, so the exact distinction this
> feature exists to draw — "this is a live connector" vs. "this is catalogued only" — would be
> silent to anyone not looking at the screen. Two tables with two captions make the distinction
> audible, not just visible. The pagination argument reinforces it independently: once the lists
> page separately, a combined `count` on one fetched page cannot be partitioned client-side without
> the two lists' visible lengths disagreeing with the pager under them.

## Related

- `docs/adr/0020-tenant-invitations-and-the-real-member-role.md` — the audit that gated
  `POST /sources`/`PATCH /sources/:id` to Admin and named the SPA gap this ADR closes, and the
  `sources/:id/sync` non-gate this ADR's own gating must not contradict.
- `docs/adr/0012-source-connector-seam.md` — the connector abstraction `connectivity`/`reachability`
  extend to repositories with no connector at all.
