import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  documentEventsUrl,
  listDocuments,
  uploadDocument,
  type DocumentSortField,
  type DocumentSourceClass,
  type DocumentVersionIngestionStatus,
  type EvidenceDocument,
  type SortDirection,
} from '../../api/client';
import Badge, { type BadgeTone } from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import Field from '../../components/ui/Field';
import FilterBar from '../../components/ui/FilterBar';
import Pager from '../../components/ui/Pager';
import Select from '../../components/ui/Select';
import Skeleton from '../../components/ui/Skeleton';
import SortableHeaderCell from '../../components/ui/SortableHeaderCell';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../../components/ui/Table';
import { notify } from '../../components/ui/toast';
import { IconFolder } from '../../components/icons';
import { workbenchHref } from '../../lib/citation-link';
import { useEventStream } from '../../lib/use-event-stream';
import { useUrlState } from '../../lib/use-url-state';
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
  { value: 'facts-failed', label: 'No facts extracted' },
];

// 'needs-ocr' and 'facts-failed' carry the same 'caution' tone as 'pending', each deliberately: a
// scanned PDF with no text layer is a gap in the corpus to flag for attention, and a 'facts-failed'
// version has real, citable chunks and only lacks extracted facts. Neither is the
// verification-grade failure 'rejected' signals elsewhere in this app. A total map rather than a
// fallthrough, so a status added to the API's union fails the type-check here instead of silently
// inheriting a tone nobody chose for it.
const INGESTION_TONE: Record<DocumentVersionIngestionStatus, BadgeTone> = {
  pending: 'caution',
  completed: 'verified',
  'facts-failed': 'caution',
  failed: 'rejected',
  'needs-ocr': 'caution',
};

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both.
const URL_DEFAULTS: Record<'ingestionStatus' | 'sort' | 'sortDir' | 'skip', string> = {
  ingestionStatus: '',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
};

export default function DocumentList() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const appliedIngestionStatus = urlState.ingestionStatus as DocumentVersionIngestionStatus | '';
  const sort = urlState.sort as DocumentSortField;
  const sortDir = urlState.sortDir as SortDirection;
  const skip = Number(urlState.skip);

  const [documents, setDocuments] = useState<EvidenceDocument[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Only this, not `appliedIngestionStatus` itself, drives the `Select` — the filter applies on
  // submit, not on every selection change, matching `AnswersPage`'s draft/applied split.
  const [draftIngestionStatus, setDraftIngestionStatus] = useState(appliedIngestionStatus);
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
      sort,
      sortDir,
    })
      .then(({ docs, count: total }) => {
        setDocuments(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load documents');
      });
  }, [skip, appliedIngestionStatus, sort, sortDir]);

  // The SSE stream (`documents.service.ts`'s `streamList`) has no `ingestionStatus`, `sort` or
  // `sortDir` parameter of its own — `DocumentsController.streamEvents` only takes `skip`/`limit`
  // — so a filter or a non-default sort in effect disables the stream (`url: null`, per
  // `useEventStream`'s own doc comment) rather than let an unfiltered, default-ordered tick
  // silently overwrite the view a reader chose. The effect below covers the fetch the stream would
  // otherwise have driven. Unfiltered and default-sorted, the URL still follows whichever page
  // `skip` names, so it stays live on every page, not only the first.
  const isDefaultView =
    appliedIngestionStatus === '' && sort === URL_DEFAULTS.sort && sortDir === URL_DEFAULTS.sortDir;

  const streamState = useEventStream<{ docs: EvidenceDocument[]; count: number }>({
    url: isDefaultView ? documentEventsUrl({ skip, limit: PAGE_SIZE }) : null,
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

  // Plain fetch-on-change while a filter or a non-default sort is applied — the stream above is
  // disabled for exactly this case, so nothing else drives the initial load or a page/filter/sort
  // change.
  useEffect(() => {
    if (isDefaultView) return;
    refetch();
  }, [isDefaultView, refetch]);

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

  function handleFilterApply() {
    setUrlState({ ingestionStatus: draftIngestionStatus, skip: URL_DEFAULTS.skip });
  }

  function handleFilterClear() {
    setDraftIngestionStatus('');
    setUrlState({ ingestionStatus: '', skip: URL_DEFAULTS.skip });
  }

  function handleSort(field: DocumentSortField) {
    // Switching to a different column always starts it at `desc`; clicking the active column
    // toggles direction, matching AnswersPage.tsx and PeoplePage.tsx.
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ sort: field, sortDir: nextDir, skip: URL_DEFAULTS.skip });
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
          {/* Mirrors UPLOAD_EXTENSION_ALLOWLIST in documents.constant.ts — the nine kinds the
              upload gate accepts. A narrower list here hides formats the server would take. */}
          <Field
            label="File"
            hint="PDF, Word, Excel, PowerPoint, CSV, TSV, Markdown, text or Email, up to 50 MB each"
          >
            {(inputProps) => (
              <input
                type="file"
                required
                multiple
                accept=".pdf,.docx,.xlsx,.pptx,.csv,.tsv,.txt,.md,.eml"
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

      <FilterBar onApply={handleFilterApply} onClear={handleFilterClear} hasFilter={hasFilter}>
        <Select
          label="Ingestion status"
          options={INGESTION_STATUS_OPTIONS}
          value={draftIngestionStatus}
          onChange={(value) =>
            setDraftIngestionStatus(value as DocumentVersionIngestionStatus | '')
          }
        />
      </FilterBar>

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
                <SortableHeaderCell<DocumentSortField>
                  field="title"
                  label="Title"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<DocumentSortField>
                  field="sourceKind"
                  label="Source"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Size</TableHeaderCell>
                <TableHeaderCell>Ingestion</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const href = workbenchHref({
                  documentId: doc.id,
                  versionId: doc.currentVersion.id,
                });
                return (
                  <TableRow key={doc.id} to={href}>
                    <TableCell label="Title">
                      <RowLink to={href}>{doc.title}</RowLink>
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
                      <Badge tone={INGESTION_TONE[doc.currentVersion.ingestionStatus]}>
                        {doc.currentVersion.ingestionStatus}
                      </Badge>
                      {doc.currentVersion.ingestionFailureReason && (
                        <p className="cell-sub">{doc.currentVersion.ingestionFailureReason}</p>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        </section>
      )}

      {documents && (
        <Pager
          count={count}
          skip={skip}
          pageSize={PAGE_SIZE}
          onSkipChange={(next) => setUrlState({ skip: String(next) })}
        />
      )}
    </div>
  );
}
