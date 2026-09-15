import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteCanonicalEntity,
  listCanonicalEntities,
  type CanonicalEntity,
  type CanonicalEntitySortField,
  type SortDirection,
} from '../api/client';
import { IconTag } from '../components/icons';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import Pager from '../components/ui/Pager';
import Panel from '../components/ui/Panel';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import { notify } from '../components/ui/toast';
import { resolveDocumentVersions, type ResolvedVersion } from '../lib/document-index';
import { clampPageSize, clampSkip, pickOption } from '../lib/paging';
import { useAbortableEffect } from '../lib/use-latest';
import { useUrlState } from '../lib/use-url-state';
import EntityEditorDialog from './canonical-entities/EntityEditorDialog';
import ProposalsQueue from './canonical-entities/ProposalsQueue';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Declared at module scope; see AnswersPage for why `useUrlState` only needs `defaults` stable in
// value, not identity. Sorts on the normalised name — the field the unique index and the server's
// default order are built on — while every row still renders the raw, operator-authored
// `canonicalName`; the registry is read by name, not by recency, hence ascending.
const URL_DEFAULTS: Record<'sort' | 'sortDir' | 'skip' | 'limit', string> = {
  sort: 'canonicalNameNormalized',
  sortDir: 'asc',
  skip: '0',
  limit: '25',
};

// Matches the server's `@IsIn` list in `list-canonical-entities.request.dto.ts`.
const SORT_FIELDS: readonly CanonicalEntitySortField[] = ['canonicalNameNormalized', 'createdAt'];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

function EntityRow({
  entity,
  onEdit,
  onDeleted,
}: {
  entity: CanonicalEntity;
  onEdit: (entity: CanonicalEntity) => void;
  onDeleted: (id: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteCanonicalEntity(entity.id);
      notify('success', `Deleted "${entity.canonicalName}".`);
      onDeleted(entity.id);
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete alias group');
      setDeleting(false);
    }
  }

  return (
    <tr>
      <TableCell label="Canonical name">{entity.canonicalName}</TableCell>
      <TableCell label="Aliases" className="cell-sub">
        {entity.aliases.length > 0 ? entity.aliases.join(', ') : 'No aliases'}
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        <Button variant="secondary" size="sm" onClick={() => onEdit(entity)}>
          Edit
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(true)}>
          Delete
        </Button>
        <ConfirmDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title={`Delete "${entity.canonicalName}"?`}
          body="Deleting removes this canonical mapping only. Facts already extracted keep whatever entity they were grouped under — this does not retroactively regroup them. This cannot be undone."
          confirmLabel="Delete entity"
          destructive
          busy={deleting}
          error={deleteError ?? undefined}
          onConfirm={() => void handleDelete()}
        />
      </TableCell>
    </tr>
  );
}

export default function CanonicalEntitiesPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  // A hand-edited or stale `sort`/`sortDir` falls back to the page default rather than reaching
  // the API with a value its `@IsIn` decorator refuses, which would otherwise blank the page.
  const sort = pickOption(urlState.sort, SORT_FIELDS, 'canonicalNameNormalized');
  const sortDir = pickOption(urlState.sortDir, SORT_DIRECTIONS, 'asc');
  const skip = clampSkip(urlState.skip);
  const pageSize = clampPageSize(urlState.limit, PAGE_SIZE_OPTIONS, Number(URL_DEFAULTS.limit));

  const [entities, setEntities] = useState<CanonicalEntity[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  // 'new' opens the dialog in create mode; an entity opens it prefilled for that row.
  const [editorTarget, setEditorTarget] = useState<CanonicalEntity | 'new' | null>(null);
  // Landmarks a delete hands focus to. `Panel` renders the `role="region"` element itself and
  // takes no ref, so the table's region is reached through the `tbody` — which is also what makes
  // its absence the signal that the table emptied and the page's primary action is the target
  // left standing.
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const addEntityRef = useRef<HTMLButtonElement>(null);
  // Armed by `handleDeleted` alone; the effect below consumes and clears it, so a reload or a sort
  // never moves focus the operator placed themselves.
  const pendingDeleteFocusRef = useRef(false);

  const load = useCallback(
    (isCurrent?: () => boolean) => {
      return listCanonicalEntities({ skip, limit: pageSize, sort, sortDir })
        .then(({ docs, count: total }) => {
          if (isCurrent?.() === false) return;
          setEntities(docs);
          setCount(total);
          setError(null);
        })
        .catch((err: unknown) => {
          if (isCurrent?.() === false) return;
          setError(err instanceof Error ? err.message : 'Failed to load alias groups');
        });
    },
    [skip, pageSize, sort, sortDir],
  );

  useAbortableEffect((isCurrent) => load(isCurrent), [load]);

  // The workbench link on each proposed alias needs the document it was read from — best-effort,
  // bounded to the entities this page already loaded.
  useAbortableEffect(
    (isCurrent) => {
      const versionIds =
        entities?.flatMap((entity) =>
          entity.harvestedAliases
            .filter((alias) => alias.status === 'proposed')
            .map((alias) => alias.documentVersionId),
        ) ?? [];
      if (versionIds.length === 0) return;

      resolveDocumentVersions(versionIds)
        .then((index) => {
          if (isCurrent()) setDocumentIndex(index);
        })
        .catch(() => {});
    },
    [entities],
  );

  // An edit patches its row in place; a create instead re-runs `load()` so the new row lands in
  // sort order rather than always heading the list, and the page never grows past `pageSize`.
  function handleSaved(saved: CanonicalEntity) {
    const exists = entities?.some((row) => row.id === saved.id) ?? false;
    if (exists) {
      setEntities(
        (current) => current?.map((row) => (row.id === saved.id ? saved : row)) ?? current,
      );
    } else {
      void load();
    }
    setEditorTarget(null);
  }

  function handleDeleted(id: string) {
    setEntities((current) => {
      const next = current?.filter((row) => row.id !== id) ?? current;
      // The row deleted was the last one on a later page but the registry itself still holds
      // others — step back rather than leave the pager stranded on a page with nothing to show.
      if (next && next.length === 0 && skip > 0 && count - 1 > 0) {
        setUrlState({ skip: String(Math.max(0, skip - pageSize)) });
      }
      return next;
    });
    setCount((current) => Math.max(0, current - 1));
    pendingDeleteFocusRef.current = true;
  }

  // Runs once the deleted row has left the DOM, taking the Delete button that had focus with it.
  // The rAF matters: `use-modal-dialog.ts`'s close cleanup finds that button detached and moves
  // focus to the page heading, from an effect not ordered against this one, so a synchronous
  // `focus()` here would race it and lose. Moving focus any earlier is not an option either — the
  // confirmation is a modal `<dialog>`, and the rest of the page is inert until it closes.
  useEffect(() => {
    if (!pendingDeleteFocusRef.current) return;
    pendingDeleteFocusRef.current = false;
    requestAnimationFrame(() => {
      const tableRegion = tbodyRef.current?.closest<HTMLElement>('[role="region"]');
      (tableRegion ?? addEntityRef.current)?.focus();
    });
  }, [entities]);

  // A confirm/reject decision returns the row it decided on — patched in place rather than
  // re-fetching, the same shape `handleSaved` already uses for the authoring dialog.
  function handleEntityChanged(updated: CanonicalEntity) {
    setEntities(
      (current) => current?.map((row) => (row.id === updated.id ? updated : row)) ?? current,
    );
  }

  function handleSort(field: CanonicalEntitySortField) {
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ sort: field, sortDir: nextDir, skip: URL_DEFAULTS.skip });
  }

  let status: RecordListStatus;
  if (entities === null) {
    status = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading alias groups…' };
  } else if (entities.length === 0 && count === 0) {
    status = {
      kind: 'empty',
      icon: <IconTag size={24} />,
      title: 'No alias groups registered yet',
      description:
        'Add one to start grouping alternate spellings of a property under a single canonical name.',
    };
  } else if (entities.length === 0) {
    status = {
      kind: 'empty',
      icon: <IconTag size={24} />,
      title: 'No alias groups on this page',
      description: 'This page is past the end of the registry.',
      action: (
        <Button
          variant="secondary"
          onClick={() => setUrlState({ skip: String(Math.max(0, skip - pageSize)) })}
        >
          Previous page
        </Button>
      ),
    };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <>
      <RecordListPage
        eyebrow="Ledger"
        title="Aliases and entities"
        description="Confirm or reject proposed spellings below, or register one yourself — an unregistered property never has its conflicts surfaced, and renaming or deleting a row here does not retroactively regroup facts already extracted."
        actions={
          <Button variant="primary" ref={addEntityRef} onClick={() => setEditorTarget('new')}>
            Add entity
          </Button>
        }
        lead={
          // Omitted entirely once the registry is confirmed empty — a registry with no entities can
          // carry no proposals either, since the queue derives them from the loaded rows, and this
          // is what keeps an empty registry to one empty state rather than two stacked.
          entities &&
          count > 0 && (
            <ProposalsQueue
              entities={entities}
              documentIndex={documentIndex}
              onEntityChanged={handleEntityChanged}
              onScanned={load}
            />
          )
        }
        error={error ?? undefined}
        status={status}
        skeletonVariant="table"
        footer={
          entities && (
            <Pager
              count={count}
              skip={skip}
              pageSize={pageSize}
              onSkipChange={(next) => setUrlState({ skip: String(next) })}
              onPageSizeChange={(next) =>
                setUrlState({ limit: String(next), skip: URL_DEFAULTS.skip })
              }
              pageSizeOptions={PAGE_SIZE_OPTIONS}
            />
          )
        }
      >
        {entities && entities.length > 0 && (
          <Panel aria-label="Alias groups and the names they resolve to">
            <Table caption="Alias groups and the names they resolve to.">
              <thead>
                <tr>
                  <SortableHeaderCell<CanonicalEntitySortField>
                    field="canonicalNameNormalized"
                    label="Canonical name"
                    sort={sort}
                    direction={sortDir}
                    onSort={handleSort}
                  />
                  <TableHeaderCell>Aliases</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </tr>
              </thead>
              <tbody ref={tbodyRef}>
                {entities.map((entity) => (
                  <EntityRow
                    key={entity.id}
                    entity={entity}
                    onEdit={setEditorTarget}
                    onDeleted={handleDeleted}
                  />
                ))}
              </tbody>
            </Table>
          </Panel>
        )}
      </RecordListPage>

      {/* A sibling of `RecordListPage`, not one of its children: children mount only under
          `ready`, while Add entity sits in `actions` and opens this under every status, including
          an empty registry. */}
      {editorTarget && (
        <EntityEditorDialog
          entity={editorTarget === 'new' ? undefined : editorTarget}
          onClose={() => setEditorTarget(null)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
