import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getDocumentById,
  listDocuments,
  uploadDocument,
  type DocumentVersion,
  type DocumentWithVersions,
  type EvidenceDocument,
} from '../api/client';

const POLL_INTERVAL_MS = 3000;

function ingestionBadge(status: DocumentVersion['ingestionStatus']): { className: string } {
  return status === 'completed'
    ? { className: 'badge badge--strong' }
    : { className: 'badge badge--possible' };
}

function DocumentDetail({ id }: { id: string }) {
  const [doc, setDoc] = useState<DocumentWithVersions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDocumentById(id)
      .then(setDoc)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load document');
      });
  }, [id]);

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
        <section className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>Version</th>
                <th>Ingestion</th>
                <th>sha256</th>
              </tr>
            </thead>
            <tbody>
              {doc.versions.map((version) => (
                <tr key={version.id}>
                  <td className="num">v{version.versionNumber}</td>
                  <td>
                    <span className={ingestionBadge(version.ingestionStatus).className}>
                      {version.ingestionStatus}
                    </span>
                  </td>
                  <td className="cell-sub mono">{version.sha256}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
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
