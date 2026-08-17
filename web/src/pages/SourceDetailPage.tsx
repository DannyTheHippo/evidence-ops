import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  getSourceById,
  type SourceFileState,
  type SourceWithFileStates,
} from '../api/client';

function fileStatusBadgeClass(status: SourceFileState['status']): string {
  return status === 'failed' ? 'badge badge--failed' : 'badge badge--strong';
}

export default function SourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [source, setSource] = useState<SourceWithFileStates | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getSourceById(id)
      .then((result) => {
        setSource(result);
        setNotFound(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load source');
      });
  }, [id]);

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Evidence</span>
          <h1 className="page-title">{source ? source.name : 'Source'}</h1>
          <p className="page-sub">Per-file sync state for this source.</p>
        </div>
        <Link to="/sources" className="btn btn--secondary btn--sm">
          Back to sources
        </Link>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!id && (
        <p className="error" role="alert">
          No source id provided.
        </p>
      )}

      {notFound && <p className="notice notice--info">Source not found.</p>}

      {!source && !error && !notFound && id && <p>Loading…</p>}

      {source && (
        <>
          <section className="card">
            <div className="card-head">
              <h2 className="card-title mono">{source.path}</h2>
              <span className={source.enabled ? 'badge badge--strong' : 'badge badge--neutral'}>
                {source.enabled ? 'enabled' : 'disabled'}
              </span>
            </div>
            <p className="cell-sub">
              {source.lastSyncAt
                ? `Last synced ${new Date(source.lastSyncAt).toLocaleString()}`
                : 'Never synced'}
            </p>
            {source.lastSyncError && <p className="error">{source.lastSyncError}</p>}
          </section>

          <section className="panel">
            {source.fileStates.length === 0 ? (
              <p className="notice notice--info">No files synced yet.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Status</th>
                    <th>Last error</th>
                    <th>Last modified</th>
                  </tr>
                </thead>
                <tbody>
                  {source.fileStates.map((fileState) => (
                    <tr key={fileState.path}>
                      <td className="mono">{fileState.path}</td>
                      <td>
                        <span className={fileStatusBadgeClass(fileState.status)}>
                          {fileState.status}
                        </span>
                      </td>
                      <td className="cell-sub">{fileState.lastError ?? '—'}</td>
                      <td className="cell-sub">{new Date(fileState.mtimeMs).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
