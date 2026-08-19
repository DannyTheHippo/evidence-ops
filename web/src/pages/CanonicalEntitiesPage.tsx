import { useCallback, useEffect, useState } from 'react';
import { deleteCanonicalEntity, listCanonicalEntities, type CanonicalEntity } from '../api/client';
import { IconTag } from '../components/icons';
import Button from '../components/ui/Button';
import Dialog from '../components/ui/Dialog';
import EmptyState from '../components/ui/EmptyState';
import Pager from '../components/ui/Pager';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableHeaderCell } from '../components/ui/Table';
import { notify } from '../components/ui/toast';
import EntityEditorDialog from './canonical-entities/EntityEditorDialog';

const PAGE_SIZE = 25;

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
      <td>{entity.canonicalName}</td>
      <td className="cell-sub">
        {entity.aliases.length > 0 ? entity.aliases.join(', ') : 'No aliases'}
      </td>
      <td className="cell-actions">
        <Button variant="secondary" size="sm" onClick={() => onEdit(entity)}>
          Edit
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(true)}>
          Delete
        </Button>
        <Dialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title={`Delete "${entity.canonicalName}"?`}
        >
          <p>
            Deleting removes this canonical mapping only. Facts already extracted keep whatever
            entity they were grouped under — this does not retroactively regroup them. This cannot
            be undone.
          </p>
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={deleting} onClick={() => void handleDelete()}>
              {deleting ? 'Deleting…' : 'Delete entity'}
            </Button>
          </div>
          {deleteError && (
            <p className="error" role="alert">
              {deleteError}
            </p>
          )}
        </Dialog>
      </td>
    </tr>
  );
}

export default function CanonicalEntitiesPage() {
  const [entities, setEntities] = useState<CanonicalEntity[] | null>(null);
  const [count, setCount] = useState(0);
  const [skip, setSkip] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // 'new' opens the dialog in create mode; an entity opens it prefilled for that row.
  const [editorTarget, setEditorTarget] = useState<CanonicalEntity | 'new' | null>(null);

  const load = useCallback(() => {
    return listCanonicalEntities({ skip, limit: PAGE_SIZE })
      .then(({ docs, count: total }) => {
        setEntities(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load canonical entities');
      });
  }, [skip]);

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

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Admin</span>
          <h1 className="page-title">Canonical Entities</h1>
          <p className="page-sub">
            Register every spelling of a property under one canonical name — an unregistered
            property never has its conflicts surfaced, and renaming or deleting a row here does not
            retroactively regroup facts already extracted.
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditorTarget('new')}>
          Add entity
        </Button>
      </div>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {!entities && !error && <Skeleton label="Loading canonical entities…" />}

      {entities && entities.length === 0 && (
        <EmptyState
          icon={<IconTag size={24} />}
          title="No canonical entities registered yet"
          description="Add one above to start grouping alternate spellings of a property under a single canonical name."
        />
      )}

      {entities && entities.length > 0 && (
        <section className="panel">
          <Table caption="Registered canonical entities and their aliases.">
            <thead>
              <tr>
                <TableHeaderCell>Canonical name</TableHeaderCell>
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

      {entities && <Pager count={count} skip={skip} pageSize={PAGE_SIZE} onSkipChange={setSkip} />}

      {editorTarget && (
        <EntityEditorDialog
          entity={editorTarget === 'new' ? undefined : editorTarget}
          onClose={() => setEditorTarget(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
