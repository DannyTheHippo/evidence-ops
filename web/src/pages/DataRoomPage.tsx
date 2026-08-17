import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteDocument,
  documentVersionContentUrl,
  getDocumentById,
  listDocuments,
  listVersionChunks,
  uploadDocument,
  type DocumentVersion,
  type DocumentWithVersions,
  type EvidenceChunkView,
  type EvidenceDocument,
} from '../api/client';
import { useSession } from '../lib/use-session';

const POLL_INTERVAL_MS = 3000;

function ingestionBadge(status: DocumentVersion['ingestionStatus']): { className: string } {
  return status === 'completed'
    ? { className: 'badge badge--strong' }
    : { className: 'badge badge--possible' };
}

function VersionRow({ version }: { version: DocumentVersion }) {
  const [chunks, setChunks] = useState<EvidenceChunkView[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleChunks() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (chunks || loading) return;
    setLoading(true);
    setError(null);
    listVersionChunks(version.id)
      .then(({ docs }) => setChunks(docs))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load chunks');
      })
      .finally(() => setLoading(false));
  }

  return (
    <>
      <tr>
        <td className="num">v{version.versionNumber}</td>
        <td>
          <span className={ingestionBadge(version.ingestionStatus).className}>
            {version.ingestionStatus}
          </span>
          {version.ingestionFailureReason && (
            <p className="cell-sub">{version.ingestionFailureReason}</p>
          )}
        </td>
        <td className="cell-sub mono">{version.sha256}</td>
        <td className="cell-actions">
          <div className="form-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={toggleChunks}>
              {expanded ? 'Hide chunks' : 'View chunks'}
            </button>
            <a className="btn btn--secondary btn--sm" href={documentVersionContentUrl(version.id)}>
              Download
            </a>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4}>
            {loading && <p>Loading chunks…</p>}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {chunks && chunks.length === 0 && (
              <p className="cell-sub">No chunks for this version.</p>
            )}
            {chunks && chunks.length > 0 && (
              <ul className="approval-list">
                {chunks.map((chunk) => (
                  <li key={chunk.id} className="card card--narrow">
                    <p className="cell-sub">
                      {chunk.locator.kind} · {chunk.tokenCount} tokens
                    </p>
                    <p>{chunk.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function DocumentDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const session = useSession();
  const [doc, setDoc] = useState<DocumentWithVersions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const armRef = useRef<HTMLButtonElement | null>(null);
  const wasConfirming = useRef(false);

  // Fails CLOSED on the still-loading probe too, matching ApprovalsPage's `canDecide` — a member
  // (or a session that hasn't resolved yet) never sees the delete control flash in before the
  // check lands. The server's RolesGuard on DELETE /documents/:id is the actual boundary.
  const canDelete = session.status === 'authed' && session.me.role === 'admin';
  // The notice states an absence of permission, so it waits for the probe to land — an admin is
  // never told they are not one while the session resolves.
  const sessionResolved = session.status !== 'loading';

  // Each step of the confirm swaps the focused button out of the tree, which would otherwise drop
  // focus to <body> and strand a keyboard user mid-delete. Arming moves focus forward to Confirm;
  // cancelling returns it to the button that armed the flow, and does nothing on first render.
  useEffect(() => {
    if (confirmingDelete) confirmRef.current?.focus();
    else if (wasConfirming.current) armRef.current?.focus();
    wasConfirming.current = confirmingDelete;
  }, [confirmingDelete]);

  useEffect(() => {
    getDocumentById(id)
      .then(setDoc)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load document');
      });
  }, [id]);

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDocument(id);
      await navigate('/documents');
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete document');
      setDeleting(false);
    }
  }

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Evidence</span>
          <h1 className="page-title">{doc?.title ?? 'Document'}</h1>
          <p className="page-sub">
            <Link to="/documents">Back to Data Room</Link>
          </p>
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!doc && !error && <p>Loading…</p>}

      {doc && (
        <>
          <section className="panel">
            <table className="grid">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Ingestion</th>
                  <th>sha256</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {doc.versions.map((version) => (
                  <VersionRow key={version.id} version={version} />
                ))}
              </tbody>
            </table>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Delete document</h2>
            </div>
            <p className="cell-sub">
              Irreversible. Removes this document, all its versions, chunks and extracted facts.
              Answers that already cited it keep their citations.
            </p>
            {sessionResolved && !canDelete && (
              <p className="cell-sub">Deleting evidence requires an admin.</p>
            )}
            {canDelete && !confirmingDelete && (
              <div className="form-actions">
                <button
                  type="button"
                  ref={armRef}
                  className="btn btn--secondary"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete document
                </button>
              </div>
            )}
            {canDelete && confirmingDelete && (
              <div className="form-actions" role="alert">
                <span className="cell-sub">Delete this document permanently?</span>
                <button
                  type="button"
                  ref={confirmRef}
                  className="btn btn--primary"
                  disabled={deleting}
                  onClick={() => void handleDelete()}
                >
                  {deleting ? 'Deleting…' : 'Confirm delete'}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={deleting}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </div>
            )}
            {deleteError && (
              <p className="error" role="alert">
                {deleteError}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function DocumentList() {
  const [documents, setDocuments] = useState<EvidenceDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Bumped to trigger a re-fetch (initial upload, or a poll tick) without an effect calling an
  // intermediate async function directly — matches the direct promise-chain shape HomePage uses.
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    listDocuments()
      .then(({ docs }) => {
        setDocuments(docs);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load documents');
      });
  }, [refreshToken]);

  const hasPending =
    documents?.some((doc) => doc.currentVersion.ingestionStatus === 'pending') ?? false;

  // Ingestion runs asynchronously after upload — poll until nothing is left pending rather than
  // implying an uploaded document is immediately queryable.
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => setRefreshToken((t) => t + 1), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasPending]);

  async function handleUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    // Sequential, not Promise.all — accumulate one error per file rather than letting an early
    // rejection hide the others, and avoid hammering the upload endpoint concurrently.
    const errors: string[] = [];
    for (const uploadFile of files) {
      try {
        await uploadDocument(uploadFile, { title: title || undefined });
      } catch (err: unknown) {
        errors.push(`${uploadFile.name}: ${err instanceof Error ? err.message : 'Upload failed'}`);
      }
    }
    setTitle('');
    setFiles([]);
    setUploading(false);
    setRefreshToken((t) => t + 1);
    if (errors.length > 0) setUploadError(errors.join('; '));
  }

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Evidence</span>
          <h1 className="page-title">Data Room</h1>
          <p className="page-sub">Upload source documents and track ingestion.</p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Upload</h2>
        </div>
        <form onSubmit={(e) => void handleUpload(e)} className="form">
          <label>
            Title
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Q3 Rent Roll"
            />
          </label>
          <label>
            File
            <input
              type="file"
              required
              multiple
              accept=".pdf,.docx,.xlsx"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <span className="form-hint">PDF, DOCX or XLSX, up to 50 MB each</span>
          </label>
          <div className="form-actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={uploading || files.length === 0}
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </form>
        {uploadError && (
          <p className="error" role="alert">
            {uploadError}
          </p>
        )}
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="panel">
        <table className="grid">
          <thead>
            <tr>
              <th>Title</th>
              <th>Source</th>
              <th>Version</th>
              <th>Ingestion</th>
            </tr>
          </thead>
          <tbody>
            {documents === null && !error && (
              <tr>
                <td className="grid-empty" colSpan={4}>
                  Loading…
                </td>
              </tr>
            )}
            {documents && documents.length === 0 && (
              <tr>
                <td className="grid-empty" colSpan={4}>
                  No documents yet.
                </td>
              </tr>
            )}
            {documents?.map((doc) => (
              <tr key={doc.id}>
                <td>
                  <Link to={`/documents/${doc.id}`}>{doc.title}</Link>
                </td>
                <td className="cell-sub">{doc.sourceKind}</td>
                <td className="num">v{doc.currentVersion.versionNumber}</td>
                <td>
                  <span className={ingestionBadge(doc.currentVersion.ingestionStatus).className}>
                    {doc.currentVersion.ingestionStatus === 'pending' && (
                      <span className="badge-dot" />
                    )}
                    {doc.currentVersion.ingestionStatus}
                  </span>
                  {doc.currentVersion.ingestionFailureReason && (
                    <p className="cell-sub">{doc.currentVersion.ingestionFailureReason}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default function DataRoomPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <DocumentDetail id={id} /> : <DocumentList />;
}
