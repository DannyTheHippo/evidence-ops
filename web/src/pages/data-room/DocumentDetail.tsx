import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  deleteDocument,
  getDocumentById,
  type DocumentWithVersions,
} from '../../api/client';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import DescriptionList from '../../components/ui/DescriptionList';
import LinkButton from '../../components/ui/LinkButton';
import PageHeader from '../../components/ui/PageHeader';
import Panel from '../../components/ui/Panel';
import Skeleton from '../../components/ui/Skeleton';
import Table, { TableHeaderCell } from '../../components/ui/Table';
import { notify } from '../../components/ui/toast';
import { useBreadcrumbs } from '../../lib/breadcrumbs';
import { useSession } from '../../lib/use-session';
import { INGESTION_TONE } from './ingestion-status';
import VersionRow from './VersionRow';

export default function DocumentDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const session = useSession();
  const [doc, setDoc] = useState<DocumentWithVersions | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Fails CLOSED on the still-loading probe too, matching AdjudicationPage's `canDecide` — a member
  // (or a session that hasn't resolved yet) never sees the delete control flash in before the
  // check lands. The server's RolesGuard on DELETE /documents/:id is the actual boundary.
  const canDelete = session.status === 'authed' && session.me.role === 'admin';
  // The notice states an absence of permission, so it waits for the probe to land — an admin is
  // never told they are not one while the session resolves.
  const sessionResolved = session.status !== 'loading';

  useEffect(() => {
    getDocumentById(id)
      .then((result) => {
        setDoc(result);
        setNotFound(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load document');
      });
  }, [id]);

  useBreadcrumbs([
    { label: 'Data room', to: '/documents' },
    { label: doc ? doc.title : 'Document' },
  ]);

  async function handleDelete() {
    if (!doc) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDocument(id);
      notify('success', `Deleted "${doc.title}".`);
      await navigate('/documents');
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete document');
      setDeleting(false);
    }
  }

  return (
    <div className="view">
      <PageHeader
        eyebrow="Estate"
        title={doc?.title ?? 'Document'}
        actions={
          <LinkButton to="/documents" variant="secondary" size="sm">
            Back to data room
          </LinkButton>
        }
      />

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {notFound && <p className="notice notice--info">Document not found.</p>}

      {!doc && !error && !notFound && <Skeleton label="Loading document…" />}

      {doc && (
        <>
          <DescriptionList
            columns={2}
            items={[
              { term: 'Source kind', description: doc.sourceKind },
              { term: 'MIME', description: <span className="mono">{doc.mimeType}</span> },
              { term: 'Versions', description: doc.versions.length },
              {
                term: 'Current',
                description: (
                  <>
                    {`v${doc.currentVersion.versionNumber} `}
                    <Badge tone={INGESTION_TONE[doc.currentVersion.ingestionStatus]}>
                      {doc.currentVersion.ingestionStatus}
                    </Badge>
                  </>
                ),
              },
            ]}
          />

          <div className="section-head">
            <h2 className="card-title">Versions</h2>
          </div>

          <Panel aria-label={`Versions of ${doc.title}`}>
            <Table caption={`Versions of ${doc.title}.`}>
              <thead>
                <tr>
                  <TableHeaderCell>Version</TableHeaderCell>
                  <TableHeaderCell>Size</TableHeaderCell>
                  <TableHeaderCell>Ingestion</TableHeaderCell>
                  <TableHeaderCell>sha256</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </tr>
              </thead>
              <tbody>
                {doc.versions.map((version) => (
                  <VersionRow key={version.id} version={version} documentId={doc.id} />
                ))}
              </tbody>
            </Table>
          </Panel>

          {/* Quiet and deliberately last: a destructive action should be findable, not
              prominent. */}
          <section className="card card--danger">
            <p className="cell-sub">Deleting a document cannot be undone.</p>
            {sessionResolved && !canDelete && (
              <p className="cell-sub">Deleting evidence requires an admin.</p>
            )}
            {canDelete && (
              <div className="form-actions">
                <Button variant="secondary" onClick={() => setConfirmOpen(true)}>
                  Delete
                </Button>
              </div>
            )}
            {canDelete && (
              <ConfirmDialog
                open={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                title={`Delete "${doc.title}"?`}
                body="Deleting cascades to all of this document's versions, chunks, extracted facts and stored bytes. Answers that already cited it keep their citations. This cannot be undone."
                confirmLabel="Delete document"
                destructive
                busy={deleting}
                error={deleteError ?? undefined}
                onConfirm={() => void handleDelete()}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}
