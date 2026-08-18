import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  documentEventsUrl,
  listDocuments,
  uploadDocument,
  type DocumentVersionIngestionStatus,
  type EvidenceDocument,
} from '../../api/client';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import Field from '../../components/ui/Field';
import Pager from '../../components/ui/Pager';
import Skeleton from '../../components/ui/Skeleton';
import Table, { RowLink, TableHeaderCell, TableRow } from '../../components/ui/Table';
import { notify } from '../../components/ui/toast';
import { useEventStream } from '../../lib/use-event-stream';
import { formatBytes } from './format-size';

const POLL_INTERVAL_MS = 3000;
const PAGE_SIZE = 20;

function ingestionTone(
  status: DocumentVersionIngestionStatus,
): 'verified' | 'caution' | 'rejected' {
  if (status === 'completed') return 'verified';
  if (status === 'failed') return 'rejected';
  return 'caution';
}

export default function DocumentList() {
  const [documents, setDocuments] = useState<EvidenceDocument[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skip, setSkip] = useState(0);
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    listDocuments({ skip, limit: PAGE_SIZE })
      .then(({ docs, count: total }) => {
        setDocuments(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load documents');
      });
  }, [skip]);

  // The SSE stream (`documents.service.ts`'s `streamList`) hardcodes the newest page, so it is
  // only correct while viewing page 1 — `url: null` disables the stream entirely on a later page
  // and this component falls back to the plain paginated fetch below instead.
  const streamState = useEventStream<{ docs: EvidenceDocument[]; count: number }>({
    url: skip === 0 ? documentEventsUrl() : null,
    events: ['documents', 'heartbeat'],
    onEvent: (name, data) => {
      // Heartbeat only keeps the connection's liveness fresh; only a `documents` frame carries a
      // list to render.
      if (name !== 'documents') return;
      setDocuments(data.docs);
      setCount(data.count);
      setError(null);
    },
    onFallback: refetch,
  });

  // A later page has no stream to fall back from — refetch it directly whenever it changes.
  useEffect(() => {
    if (skip !== 0) refetch();
  }, [skip, refetch]);

  const hasPending =
    documents?.some((doc) => doc.currentVersion.ingestionStatus === 'pending') ?? false;

  // The stream carries updates while it is live; this only runs once the hook has actually fallen
  // back to polling, and only while ingestion is still in flight — a dropped stream must still
  // reach a resolved state, not sit stale forever.
  useEffect(() => {
    if (streamState !== 'fallback' || !hasPending) return;
    const timer = setInterval(refetch, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [streamState, hasPending, refetch]);

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
    const uploadedCount = files.length - errors.length;
    setTitle('');
    setFiles([]);
    setUploading(false);
    refetch();
    if (uploadedCount > 0) {
      notify(
        'success',
        uploadedCount === 1 ? 'Uploaded 1 file.' : `Uploaded ${uploadedCount} files.`,
      );
    }
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
          <Field label="Title">
            {(inputProps) => (
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Q3 Rent Roll"
                {...inputProps}
              />
            )}
          </Field>
          {/* Mirrors UPLOAD_EXTENSION_ALLOWLIST in documents.constant.ts — the eight kinds the
              upload gate accepts. A narrower list here hides formats the server would take. */}
          <Field
            label="File"
            hint="PDF, Word, Excel, PowerPoint, CSV, TSV, Markdown or text, up to 50 MB each"
          >
            {(inputProps) => (
              <input
                type="file"
                required
                multiple
                accept=".pdf,.docx,.xlsx,.pptx,.csv,.tsv,.txt,.md"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                {...inputProps}
              />
            )}
          </Field>
          <div className="form-actions">
            <Button type="submit" disabled={uploading || files.length === 0}>
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        </form>
        {uploadError && (
          <p className="error" role="alert">
            {uploadError}
          </p>
        )}
      </section>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {documents === null && !error && <Skeleton label="Loading documents…" />}

      {documents && documents.length === 0 && (
        <EmptyState
          title="No documents yet"
          description="Upload a source document above to start tracking its ingestion."
        />
      )}

      {documents && documents.length > 0 && (
        <section className="panel">
          <Table caption="Documents uploaded to the data room, with their ingestion status.">
            <thead>
              <tr>
                <TableHeaderCell>Title</TableHeaderCell>
                <TableHeaderCell>Source</TableHeaderCell>
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Size</TableHeaderCell>
                <TableHeaderCell>Ingestion</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <TableRow key={doc.id} to={`/documents/${doc.id}`}>
                  <td>
                    <RowLink to={`/documents/${doc.id}`}>{doc.title}</RowLink>
                  </td>
                  <td>
                    {doc.sourceKind}
                    <p className="cell-sub">{doc.mimeType}</p>
                  </td>
                  <td className="num">v{doc.currentVersion.versionNumber}</td>
                  <td className="num">{formatBytes(doc.currentVersion.sizeBytes)}</td>
                  <td>
                    <Badge tone={ingestionTone(doc.currentVersion.ingestionStatus)}>
                      {doc.currentVersion.ingestionStatus}
                    </Badge>
                    {doc.currentVersion.ingestionFailureReason && (
                      <p className="cell-sub">{doc.currentVersion.ingestionFailureReason}</p>
                    )}
                  </td>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {documents && <Pager count={count} skip={skip} pageSize={PAGE_SIZE} onSkipChange={setSkip} />}
    </div>
  );
}
