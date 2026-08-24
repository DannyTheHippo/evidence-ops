import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  documentEventsUrl,
  listDocuments,
  uploadDocument,
  type DocumentSourceClass,
  type DocumentVersionIngestionStatus,
  type EvidenceDocument,
} from '../../api/client';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import Field from '../../components/ui/Field';
import Pager from '../../components/ui/Pager';
import Select from '../../components/ui/Select';
import Skeleton from '../../components/ui/Skeleton';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../../components/ui/Table';
import { notify } from '../../components/ui/toast';
import { IconFolder } from '../../components/icons';
import { useEventStream } from '../../lib/use-event-stream';
import { formatBytes } from './format-size';

const POLL_INTERVAL_MS = 3000;
const PAGE_SIZE = 20;

// No 'unclassified' option — leaving the field unset is how an uploader says that; the server
// defaults an omitted sourceClass to it already.
const SOURCE_CLASS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Not specified' },
  { value: 'crm-export', label: 'CRM export' },
  { value: 'pm-export', label: 'PM export' },
  { value: 'spreadsheet', label: 'Spreadsheet' },
  { value: 'memo', label: 'Memo' },
  { value: 'report', label: 'Report' },
];

const INGESTION_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'needs-ocr', label: 'Needs OCR' },
];

// 'needs-ocr' falls through to the same 'caution' tone as 'pending' — deliberately, not merely by
// omission: a scanned PDF with no text layer is a gap in the corpus to flag for attention, not the
// verification-grade failure 'rejected' signals elsewhere in this app.
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
  const [ingestionStatusFilter, setIngestionStatusFilter] = useState<
    DocumentVersionIngestionStatus | ''
  >('');
  // Only this, not `ingestionStatusFilter` itself, drives the fetch — the filter applies on
  // submit, not on every selection change, matching `AnswersPage`'s input-state/applied-state
  // split.
  const [appliedIngestionStatus, setAppliedIngestionStatus] = useState<
    DocumentVersionIngestionStatus | ''
  >('');
  const [title, setTitle] = useState('');
  const [sourceClass, setSourceClass] = useState<DocumentSourceClass | ''>('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Blocks a double submit between the click and the re-render that disables the submit button —
  // `disabled={uploading}` alone only takes effect once React has committed it, and each upload
  // creates a real document.
  const uploadInFlightRef = useRef(false);

  const refetch = useCallback(() => {
    listDocuments({
      skip,
      limit: PAGE_SIZE,
      ingestionStatus: appliedIngestionStatus === '' ? undefined : appliedIngestionStatus,
    })
      .then(({ docs, count: total }) => {
        setDocuments(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load documents');
      });
  }, [skip, appliedIngestionStatus]);

  // The SSE stream (`documents.service.ts`'s `streamList`) has no `ingestionStatus` parameter of
  // its own — `DocumentsController.streamEvents` only takes `skip`/`limit` — so a filter in effect
  // disables the stream (`url: null`, per `useEventStream`'s own doc comment) rather than let an
  // unfiltered tick silently overwrite the filtered list. The effect below covers the fetch the
  // stream would otherwise have driven. Unfiltered, the URL still follows whichever page `skip`
  // names, so it stays live on every page, not only the first.
  const streamState = useEventStream<{ docs: EvidenceDocument[]; count: number }>({
    url: appliedIngestionStatus === '' ? documentEventsUrl({ skip, limit: PAGE_SIZE }) : null,
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

  // Plain fetch-on-change while a filter is applied — the stream above is disabled for exactly
  // this case, so nothing else drives the initial load or a page/filter change.
  useEffect(() => {
    if (appliedIngestionStatus === '') return;
    refetch();
  }, [appliedIngestionStatus, skip, refetch]);

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
    if (uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    setUploading(true);
    setUploadError(null);
    // Sequential, not Promise.all — accumulate one error per file rather than letting an early
    // rejection hide the others, and avoid hammering the upload endpoint concurrently.
    const errors: string[] = [];
    for (const uploadFile of files) {
      try {
        await uploadDocument(uploadFile, {
          title: title || undefined,
          sourceClass: sourceClass || undefined,
        });
      } catch (err: unknown) {
        errors.push(`${uploadFile.name}: ${err instanceof Error ? err.message : 'Upload failed'}`);
      }
    }
    const uploadedCount = files.length - errors.length;
    setTitle('');
    setSourceClass('');
    setFiles([]);
    setUploading(false);
    uploadInFlightRef.current = false;
    refetch();
    if (uploadedCount > 0) {
      notify(
        'success',
        uploadedCount === 1 ? 'Uploaded 1 file.' : `Uploaded ${uploadedCount} files.`,
      );
    }
    if (errors.length > 0) setUploadError(errors.join('; '));
  }

  function handleFilter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSkip(0);
    setAppliedIngestionStatus(ingestionStatusFilter);
  }

  const hasFilter = appliedIngestionStatus !== '';

  return (
    <div className="view">
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
          <Select
            label="Source class"
            hint="Authority for future conflicts on this metric. Leave unset for unclassified."
            options={SOURCE_CLASS_OPTIONS}
            value={sourceClass}
            onChange={(value) => setSourceClass(value as DocumentSourceClass | '')}
          />
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

      <form onSubmit={handleFilter} className="control-row">
        <Select
          label="Ingestion status"
          options={INGESTION_STATUS_OPTIONS}
          value={ingestionStatusFilter}
          onChange={(value) =>
            setIngestionStatusFilter(value as DocumentVersionIngestionStatus | '')
          }
        />
        <Button type="submit" variant="primary">
          Apply filters
        </Button>
      </form>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {documents === null && !error && <Skeleton label="Loading documents…" />}

      {documents && documents.length === 0 && hasFilter && (
        <EmptyState
          icon={<IconFolder size={24} />}
          title="No documents match this filter"
          description="Clear or adjust the ingestion status filter above."
        />
      )}

      {documents && documents.length === 0 && !hasFilter && (
        <EmptyState
          icon={<IconFolder size={24} />}
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
                  <TableCell label="Title">
                    <RowLink to={`/documents/${doc.id}`}>{doc.title}</RowLink>
                  </TableCell>
                  <TableCell label="Source">
                    {doc.sourceKind}
                    <p className="cell-sub">{doc.mimeType}</p>
                  </TableCell>
                  <TableCell label="Version" className="num">
                    v{doc.currentVersion.versionNumber}
                  </TableCell>
                  <TableCell label="Size" className="num">
                    {formatBytes(doc.currentVersion.sizeBytes)}
                  </TableCell>
                  <TableCell label="Ingestion">
                    <Badge tone={ingestionTone(doc.currentVersion.ingestionStatus)}>
                      {doc.currentVersion.ingestionStatus}
                    </Badge>
                    {doc.currentVersion.ingestionFailureReason && (
                      <p className="cell-sub">{doc.currentVersion.ingestionFailureReason}</p>
                    )}
                  </TableCell>
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
