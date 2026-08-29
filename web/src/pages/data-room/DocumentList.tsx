import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
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
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import Field from '../../components/ui/Field';
import FilterBar from '../../components/ui/FilterBar';
import PageHeader from '../../components/ui/PageHeader';
import Pager from '../../components/ui/Pager';
import Panel from '../../components/ui/Panel';
import Select from '../../components/ui/Select';
import Skeleton from '../../components/ui/Skeleton';
import SortableHeaderCell from '../../components/ui/SortableHeaderCell';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../../components/ui/Table';
import Toolbar from '../../components/ui/Toolbar';
import { notify } from '../../components/ui/toast';
import { IconFolder } from '../../components/icons';
import { workbenchHref } from '../../lib/citation-link';
import { useEventStream } from '../../lib/use-event-stream';
import { useFormSubmit } from '../../lib/use-form-submit';
import { useUrlState } from '../../lib/use-url-state';
import { formatBytes } from './format-size';
import { INGESTION_TONE } from './ingestion-status';
import UploadQueue, { type QueueRow } from './UploadQueue';

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

// Mirrors UPLOAD_EXTENSION_ALLOWLIST in documents.constant.ts — the nine kinds the upload gate
// accepts. A narrower list here hides formats the server would take; a wider one only reaches the
// server's own rejection, since this pre-check is a courtesy, not the authority.
const UPLOAD_ACCEPT = '.pdf,.docx,.xlsx,.pptx,.csv,.tsv,.txt,.md,.eml';
const UPLOAD_ALLOWED_EXTENSIONS = UPLOAD_ACCEPT.split(',');

// Mirrors MAX_FILE_SIZE_BYTES in documents.constant.ts.
const MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024;

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both.
const URL_DEFAULTS: Record<'ingestionStatus' | 'sort' | 'sortDir' | 'skip', string> = {
  ingestionStatus: '',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
};

type UploadField = 'files';

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

// A courtesy check the server re-enforces authoritatively. Drag-and-drop bypasses the file input's
// own `accept` attribute entirely, so this is the only thing standing between a dropped file and a
// doomed request for either failure mode below.
function precheckUploadFile(file: File): string | null {
  if (!UPLOAD_ALLOWED_EXTENSIONS.includes(fileExtension(file.name))) {
    return 'Unsupported file type.';
  }
  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    return 'File exceeds the 50 MB limit.';
  }
  return null;
}

// Deliberately not RecordListPage: this page owns an SSE subscription and an upload region the
// shared list-page scaffold has no slot for. Do not fold it onto RecordListPage in a later sweep.
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
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Keyed by QueueRow.id, holding only the rows currently 'queued' — a row that failed its client
  // pre-check never gets an entry here, and a submitted row's entry is removed once it settles.
  const pendingFilesRef = useRef<Map<string, File>>(new Map());
  const nextRowIdRef = useRef(0);

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

  function addUploadFiles(incoming: File[]) {
    const additions: QueueRow[] = incoming.map((file) => {
      const id = String(nextRowIdRef.current++);
      const failure = precheckUploadFile(file);
      if (failure) {
        return { id, fileName: file.name, state: { kind: 'failed', message: failure } };
      }
      pendingFilesRef.current.set(id, file);
      return { id, fileName: file.name, state: { kind: 'queued' } };
    });
    setQueue((rows) => [...rows, ...additions]);
  }

  function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    addUploadFiles(Array.from(e.target.files ?? []));
    // Clears the native control so selecting the same file again still fires a change event —
    // the file itself already lives in the queue, not in the input's own selection anymore.
    e.target.value = '';
  }

  function handleDragOver(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragOver(false);
    addUploadFiles(Array.from(e.dataTransfer.files));
  }

  function updateQueueRow(id: string, state: QueueRow['state']) {
    setQueue((rows) => rows.map((row) => (row.id === id ? { ...row, state } : row)));
  }

  function validateUpload(): Partial<Record<UploadField, string>> {
    const hasQueuedFile = queue.some((row) => row.state.kind === 'queued');
    return hasQueuedFile ? {} : { files: 'Select at least one file to upload.' };
  }

  async function submitUpload() {
    const batch = queue.filter((row) => row.state.kind === 'queued');
    let uploadedCount = 0;
    for (const row of batch) {
      const file = pendingFilesRef.current.get(row.id);
      if (!file) continue;
      updateQueueRow(row.id, { kind: 'uploading' });
      try {
        await uploadDocument(file, {
          title: title || undefined,
          sourceClass: sourceClass || undefined,
        });
        uploadedCount += 1;
        updateQueueRow(row.id, { kind: 'uploaded' });
      } catch (err) {
        // The message an ApiError carries already folds in any per-field detail the server sent —
        // this row's own file name is what disambiguates it from every other row, so nothing here
        // needs to re-mention the title uploadDocument may have silently substituted for it.
        updateQueueRow(row.id, {
          kind: 'failed',
          message: err instanceof Error ? err.message : 'Upload failed',
        });
      } finally {
        pendingFilesRef.current.delete(row.id);
      }
    }
    refetch();
    // Cleared only once the outcome is known, and only once at least one file actually uploaded —
    // a batch that fails outright leaves title and source class exactly as typed, so retrying
    // never means retyping them.
    if (uploadedCount > 0) {
      setTitle('');
      setSourceClass('');
      notify(
        'success',
        uploadedCount === 1 ? 'Uploaded 1 file.' : `Uploaded ${uploadedCount} files.`,
      );
    }
  }

  // No ErrorSummary: the file control is the only field that can fail client-side, and a per-file
  // server failure belongs on its own row in the queue, not folded into a summary block.
  const { pending, onSubmit, fieldProps } = useFormSubmit<UploadField>({
    validate: validateUpload,
    submit: submitUpload,
  });
  const filesField = fieldProps('files');

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
  // Makes the ADR-0017 stream pause visible rather than leaving the page silently stale: a filter
  // or non-default sort always disables the stream, independent of whatever `streamState` itself
  // reads, so that case is checked first.
  const statusLine = !isDefaultView
    ? 'updates paused — filter or sort applied'
    : streamState === 'fallback'
      ? 'polling'
      : 'live';

  return (
    <div className="view">
      <PageHeader
        eyebrow="Evidence"
        title="Data Room"
        description="Upload source documents and track ingestion."
      />

      <div className="split-view split-view--upload">
        <div className="split-view-pane">
          {/* The whole card is a drag-and-drop target, as a progressive enhancement over the
              native file input below — which stays visible and keyboard-operable rather than
              being replaced, since a drop target that hides the input would strand a keyboard
              user. */}
          <section
            className="card upload-card"
            data-dragover={dragOver || undefined}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="card-head">
              <h2 className="card-title">Upload</h2>
            </div>
            <form onSubmit={onSubmit} className="form" noValidate>
              <Field label="Title" hint="Applies to every file in this batch" optional>
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
              <Field
                id={filesField.id}
                label="File"
                hint="PDF, Word, Excel, PowerPoint, CSV, TSV, Markdown, text or Email, up to 50 MB each"
                error={filesField.error}
              >
                {(inputProps) => (
                  <input
                    type="file"
                    required
                    multiple
                    accept={UPLOAD_ACCEPT}
                    onChange={handleFileInputChange}
                    onBlur={filesField.onBlur}
                    {...inputProps}
                  />
                )}
              </Field>
              <div className="form-actions">
                <Button type="submit" disabled={pending}>
                  {pending ? 'Uploading…' : 'Upload'}
                </Button>
              </div>
            </form>
          </section>
        </div>
        <div className="split-view-pane">
          <UploadQueue rows={queue} />
        </div>
      </div>

      <Toolbar
        start={
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
        }
        end={
          documents && (
            <span className="mono cell-sub" role="status">
              {count} {count === 1 ? 'document' : 'documents'} · {statusLine}
            </span>
          )
        }
      />

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
        <Panel aria-label="Documents uploaded to the data room, with their ingestion status">
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
                <TableHeaderCell>Ingestion</TableHeaderCell>
                <SortableHeaderCell<DocumentSortField>
                  field="sourceKind"
                  label="Source"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Size</TableHeaderCell>
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
                    <TableCell label="Ingestion">
                      <Badge tone={INGESTION_TONE[doc.currentVersion.ingestionStatus]}>
                        {doc.currentVersion.ingestionStatus}
                      </Badge>
                      {doc.currentVersion.ingestionFailureReason && (
                        <p className="cell-sub">{doc.currentVersion.ingestionFailureReason}</p>
                      )}
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
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        </Panel>
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
