import { useCallback, useEffect, useState } from 'react';
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
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import { notify } from '../components/ui/toast';
import { useUrlState } from '../lib/use-url-state';
import EntityEditorDialog from './canonical-entities/EntityEditorDialog';
import ProposalsQueue from './canonical-entities/ProposalsQueue';

const PAGE_SIZE = 25;

// Declared at module scope; see AnswersPage for why `useUrlState` only needs `defaults` stable in
// value, not identity. Sorts on the normalised name — the field the unique index and the server's
// default order are built on — while every row still renders the raw, operator-authored
// `canonicalName`; the registry is read by name, not by recency, hence ascending.
const URL_DEFAULTS: Record<'sort' | 'sortDir' | 'skip', string> = {
  sort: 'canonicalNameNormalized',
  sortDir: 'asc',
  skip: '0',
};

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
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete canonical entity');
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
  const sort = urlState.sort as CanonicalEntitySortField;
  const sortDir = urlState.sortDir as SortDirection;
  const skip = Number(urlState.skip);

  const [entities, setEntities] = useState<CanonicalEntity[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // 'new' opens the dialog in create mode; an entity opens it prefilled for that row.
  const [editorTarget, setEditorTarget] = useState<CanonicalEntity | 'new' | null>(null);

  const load = useCallback(() => {
    return listCanonicalEntities({ skip, limit: PAGE_SIZE, sort, sortDir })
      .then(({ docs, count: total }) => {
        setEntities(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load canonical entities');
      });
  }, [skip, sort, sortDir]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleSaved(saved: CanonicalEntity) {
    setEntities((current) => {
      if (!current) return current;
      const exists = current.some((row) => row.id === saved.id);
      if (!exists) setCount((total) => total + 1);
      return exists
        ? current.map((row) => (row.id === saved.id ? saved : row))
        : [saved, ...current];
    });
    setEditorTarget(null);
  }

  function handleDeleted(id: string) {
    setEntities((current) => current?.filter((row) => row.id !== id) ?? current);
    setCount((current) => Math.max(0, current - 1));
  }

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
    status = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading canonical entities…' };
  } else if (entities.length === 0) {
    status = {
      kind: 'empty',
      icon: <IconTag size={24} />,
      title: 'No canonical entities registered yet',
      description:
        'Add one to start grouping alternate spellings of a property under a single canonical name.',
    };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Admin"
      title="Canonical Entities"
      description="Confirm or reject proposed spellings below, or register one yourself — an unregistered property never has its conflicts surfaced, and renaming or deleting a row here does not retroactively regroup facts already extracted."
      actions={
        <Button variant="primary" onClick={() => setEditorTarget('new')}>
          Add entity
        </Button>
      }
      filters={
        entities && (
          <ProposalsQueue
            entities={entities}
            onEntityChanged={handleEntityChanged}
            onScanned={load}
          />
        )
      }
      error={error ?? undefined}
      status={status}
      footer={
        entities && (
          <Pager
            count={count}
            skip={skip}
            pageSize={PAGE_SIZE}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
          />
        )
      }
    >
      {entities && entities.length > 0 && (
        <section className="panel">
          <Table caption="Registered canonical entities and their aliases.">
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
            <tbody>
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
        </section>
      )}

      {editorTarget && (
        <EntityEditorDialog
          entity={editorTarget === 'new' ? undefined : editorTarget}
          onClose={() => setEditorTarget(null)}
          onSaved={handleSaved}
        />
      )}
    </RecordListPage>
  );
}
