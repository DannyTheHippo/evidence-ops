import { useCallback, useEffect, useRef, useState } from 'react';
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
import Alert from '../../components/ui/Alert';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import EmptyState from '../../components/ui/EmptyState';
import ErrorSummary from '../../components/ui/ErrorSummary';
import Field from '../../components/ui/Field';
import FileInput, { type FileInputFile } from '../../components/ui/FileInput';
import FilterBar from '../../components/ui/FilterBar';
import LinkButton from '../../components/ui/LinkButton';
import PageHeader from '../../components/ui/PageHeader';
import Pager from '../../components/ui/Pager';
import Panel from '../../components/ui/Panel';
import Select from '../../components/ui/Select';
import Skeleton from '../../components/ui/Skeleton';
import SortableHeaderCell from '../../components/ui/SortableHeaderCell';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../../components/ui/Table';
import Timestamp from '../../components/ui/Timestamp';
import Toolbar from '../../components/ui/Toolbar';
import Tooltip from '../../components/ui/Tooltip';
import { notify } from '../../components/ui/toast';
import { IconFolder } from '../../components/icons';
import { workbenchHref } from '../../lib/citation-link';
import { formatBytes } from '../../lib/format-size';
import { clampPageSize, clampSkip, pickOption } from '../../lib/paging';
import { precheckUploadFile, UPLOAD_ACCEPT } from '../../lib/upload-accept';
import { CONNECTION_LABELS, useEventStream, type StreamState } from '../../lib/use-event-stream';
import { useFormSubmit } from '../../lib/use-form-submit';
import { useUrlState } from '../../lib/use-url-state';
import { INGESTION_LABEL, INGESTION_TONE, SOURCE_CLASS_LABEL } from './ingestion-status';
import UploadQueue, { type QueueRow } from './UploadQueue';

// Duplicated rather than shared: `lib/use-answer-run.ts` keeps the same list module-private.
const POLLING_STREAM_STATES: readonly StreamState[] = ['stale', 'reconnecting', 'fallback'];
const POLL_INTERVAL_MS = 3000; // a version is still ingesting
const IDLE_POLL_INTERVAL_MS = 15_000; // nothing pending; the stream is simply not delivering

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

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that
// identity, but only needs it stable in value — a module-level object satisfies both.
const URL_DEFAULTS: Record<'ingestionStatus' | 'sort' | 'sortDir' | 'skip' | 'limit', string> = {
  ingestionStatus: '',
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
  limit: '25',
};

// Matches the server's `@IsIn` list in `list-documents.request.dto.ts`.
const SORT_FIELDS: readonly DocumentSortField[] = ['createdAt', 'title', 'sourceKind'];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

type UploadField = 'files';

// Deliberately not RecordListPage: this page owns an SSE subscription and an upload region the
// shared list-page scaffold has no slot for. Do not fold it onto RecordListPage in a later sweep.
export default function DocumentList() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const appliedIngestionStatus = urlState.ingestionStatus as DocumentVersionIngestionStatus | '';
  // A hand-edited or stale `sort`/`sortDir` falls back to the page default rather than reaching
  // the API with a value its `@IsIn` decorator refuses, which would otherwise blank the page.
  const sort = pickOption(urlState.sort, SORT_FIELDS, 'createdAt');
  const sortDir = pickOption(urlState.sortDir, SORT_DIRECTIONS, 'desc');
  // A `?skip=` or `?limit=` the API would refuse, or the Pager cannot represent, never reaches the
  // list request or the stream URL.
  const skip = clampSkip(urlState.skip);
  const limit = clampPageSize(urlState.limit, [25, 50, 100], Number(URL_DEFAULTS.limit));

  const [documents, setDocuments] = useState<EvidenceDocument[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [sourceClass, setSourceClass] = useState<DocumentSourceClass | ''>('');
  const [queue, setQueue] = useState<QueueRow[]>([]);
  // Keyed by QueueRow.id, holding the File for every row still in 'staged' or 'rejected' state —
  // `FileInput` renders both from real `File` objects, not just a name — through 'uploading' until
  // the request settles. State rather than a ref: the staged list is read while rendering, and a
  // file added or removed has to reach that render.
  const [pendingFiles, setPendingFiles] = useState<Map<string, File>>(new Map());
  const nextRowIdRef = useRef(0);
  // Bumped by every `refetch`, every stream `documents` frame, and every switch between the default
  // and a filtered or sorted view. A `refetch` response applies only while its sequence is still
  // the latest, so a response that a newer fetch, a stream frame or a view change superseded drops
  // instead of overwriting what is on screen.
  const fetchSequenceRef = useRef(0);

  const refetch = useCallback(() => {
    const sequence = ++fetchSequenceRef.current;
    listDocuments({
      skip,
      limit,
      ingestionStatus: appliedIngestionStatus === '' ? undefined : appliedIngestionStatus,
      sort,
      sortDir,
    })
      .then(({ docs, count: total }) => {
        if (sequence !== fetchSequenceRef.current) return;
        setDocuments(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        if (sequence !== fetchSequenceRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load documents');
      });
  }, [skip, limit, appliedIngestionStatus, sort, sortDir]);

  // The SSE stream (`documents.service.ts`'s `streamList`) has no `ingestionStatus`, `sort` or
  // `sortDir` parameter of its own — `DocumentsController.streamEvents` only takes `skip`/`limit`
  // — so a filter or a non-default sort in effect disables the stream (`url: null`, per
  // `useEventStream`'s own doc comment) rather than let an unfiltered, default-ordered tick
  // silently overwrite the view a reader chose. The effect below covers the fetch the stream would
  // otherwise have driven. Unfiltered and default-sorted, the URL still follows whichever page
  // `skip` names, so it stays live on every page, not only the first.
  const isDefaultView =
    appliedIngestionStatus === '' && sort === URL_DEFAULTS.sort && sortDir === URL_DEFAULTS.sortDir;

  // Declared ahead of `useEventStream` so it runs before the stream's connection effect, which
  // calls `refetch` synchronously when it falls back; bumping after that call would drop its
  // response.
  useEffect(() => {
    fetchSequenceRef.current += 1;
  }, [isDefaultView]);

  const streamState = useEventStream<{ docs: EvidenceDocument[]; count: number }>({
    url: isDefaultView ? documentEventsUrl({ skip, limit }) : null,
    events: ['documents', 'heartbeat'],
    onEvent: (name, data) => {
      // Heartbeat only keeps the connection's liveness fresh; only a `documents` frame carries a
      // list to render.
      if (name !== 'documents') return;
      fetchSequenceRef.current += 1;
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

  // Polls whenever the stream itself is not delivering: in the default view that means
  // stale/reconnecting/fallback; with a filter or non-default sort the stream is disabled
  // outright, so a pending version is the only reason to keep refetching on a timer.
  const shouldPoll = isDefaultView ? POLLING_STREAM_STATES.includes(streamState) : hasPending;
  const pollMs = hasPending ? POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(refetch, pollMs);
    return () => clearInterval(timer);
  }, [shouldPoll, pollMs, refetch]);

  // A page past the first that comes back empty — its rows were deleted, or a page size grew and
  // swallowed them — pages back to the last page that still holds rows, so the pager's range and
  // the body can never disagree about whether there is anything to show.
  useEffect(() => {
    if (skip === 0 || documents === null || documents.length > 0) return;
    const lastPageSkip = Math.max(0, Math.floor(Math.max(0, count - 1) / limit) * limit);
    if (lastPageSkip === skip) return;
    setUrlState({ skip: String(lastPageSkip) });
  }, [skip, limit, count, documents, setUrlState]);

  // Cancels the browser's default for every drag and drop of a *file* that reaches `window`, so a
  // file released anywhere on the page — beside `FileInput`, or on it while an upload disables it
  // — never navigates the tab to the file and discards the queue. React's root listener has
  // already delivered the event to `FileInput` by the time it bubbles here, and cancelling never
  // stops propagation, so a drop on the enabled zone still stages its files. A drag carrying no
  // file — text dragged into the Title field, say — has no stray file to guard against, so it
  // keeps the browser's native handling.
  useEffect(() => {
    function guardStrayDrop(e: DragEvent) {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
    }
    window.addEventListener('dragover', guardStrayDrop);
    window.addEventListener('drop', guardStrayDrop);
    return () => {
      window.removeEventListener('dragover', guardStrayDrop);
      window.removeEventListener('drop', guardStrayDrop);
    };
  }, []);

  function addUploadFiles(incoming: File[]) {
    const added = new Map<string, File>();
    const additions: QueueRow[] = incoming.map((file) => {
      const id = String(nextRowIdRef.current++);
      added.set(id, file);
      const failure = precheckUploadFile(file);
      return failure
        ? { id, fileName: file.name, state: { kind: 'rejected' as const, message: failure } }
        : { id, fileName: file.name, state: { kind: 'staged' as const } };
    });
    setPendingFiles((files) => new Map([...files, ...added]));
    setQueue((rows) => [...rows, ...additions]);
  }

  // `FileInput.files` is built from the `staged` and `rejected` rows in the same order, so an
  // index from its `onFileRemoved` maps straight back to a row here.
  const stagedRows = queue.filter(
    (row) => row.state.kind === 'staged' || row.state.kind === 'rejected',
  );
  const stagedFiles: FileInputFile[] = stagedRows.flatMap((row) => {
    const file = pendingFiles.get(row.id);
    if (!file) return [];
    return [{ file, error: row.state.kind === 'rejected' ? row.state.message : undefined }];
  });

  function forgetPendingFile(id: string) {
    setPendingFiles((files) => {
      const next = new Map(files);
      next.delete(id);
      return next;
    });
  }

  function handleFileRemoved(index: number) {
    const row = stagedRows[index];
    if (!row) return;
    setQueue((rows) => rows.filter((r) => r.id !== row.id));
    forgetPendingFile(row.id);
  }

  function handleClearFinished() {
    setQueue((rows) =>
      rows.filter((row) => row.state.kind !== 'uploaded' && row.state.kind !== 'failed'),
    );
  }

  function updateQueueRow(id: string, state: QueueRow['state']) {
    setQueue((rows) => rows.map((row) => (row.id === id ? { ...row, state } : row)));
  }

  function validateUpload(): Partial<Record<UploadField, string>> {
    const pendingRows = queue.filter(
      (row) => row.state.kind === 'staged' || row.state.kind === 'rejected',
    );
    if (pendingRows.length === 0) return { files: 'Select at least one file to upload.' };
    const hasStagedFile = pendingRows.some((row) => row.state.kind === 'staged');
    return hasStagedFile
      ? {}
      : {
          files:
            'Every selected file was rejected. Remove them and choose a supported file type under 50 MB.',
        };
  }

  async function submitUpload() {
    const batch = queue.filter((row) => row.state.kind === 'staged');
    let uploadedCount = 0;
    for (const row of batch) {
      const file = pendingFiles.get(row.id);
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
        forgetPendingFile(row.id);
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

  const {
    pending,
    formError,
    onSubmit,
    fieldProps,
    summary: { ref: summaryRef, errors: summaryErrors },
  } = useFormSubmit<UploadField>({
    validate: validateUpload,
    submit: submitUpload,
  });
  const filesField = fieldProps('files');

  // Clears the sort with the filter, so one control returns the table to the unfiltered,
  // default-ordered view the live stream requires.
  function handleFilterClear() {
    setUrlState({
      ingestionStatus: '',
      sort: URL_DEFAULTS.sort,
      sortDir: URL_DEFAULTS.sortDir,
      skip: URL_DEFAULTS.skip,
    });
  }

  function handleSort(field: DocumentSortField) {
    // Switching to a different column always starts it at `desc`; clicking the active column
    // toggles direction, matching AnswersPage.tsx and PeoplePage.tsx.
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ sort: field, sortDir: nextDir, skip: URL_DEFAULTS.skip });
  }

  const hasFilter = appliedIngestionStatus !== '';
  const countText = `${count} ${count === 1 ? 'document' : 'documents'}`;
  // A filter or non-default sort always disables the stream (see `isDefaultView` above; `url:
  // null` there publishes plain `idle`), independent of whatever `streamState` itself reads.
  // `Idle` describes a page with no stream at all; this case has a reason the operator can act
  // on, so it gets its own words rather than the stream vocabulary.
  const statusLabel = isDefaultView ? CONNECTION_LABELS[streamState].label : 'Updates paused';
  const statusDetail = isDefaultView
    ? streamState === 'live'
      ? null
      : CONNECTION_LABELS[streamState].detail
    : 'Filter or sort applied — the live channel is off.';

  return (
    <div className="view">
      <PageHeader
        eyebrow="Estate"
        title="Data room"
        description="Upload source documents and track ingestion."
      />

      <div className="split-view split-view--upload">
        <div className="split-view-pane">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Upload</h2>
            </div>
            <form onSubmit={onSubmit} className="form" noValidate>
              <ErrorSummary
                ref={summaryRef}
                errors={summaryErrors}
                formError={formError ?? undefined}
              />
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
              <FileInput
                id={filesField.id}
                name="files"
                label="File"
                hint="PDF, Word, Excel, PowerPoint, CSV, TSV, Markdown, text, email or HTML, up to 50 MB each"
                accept={UPLOAD_ACCEPT}
                multiple
                files={stagedFiles}
                onFilesAdded={addUploadFiles}
                onFileRemoved={handleFileRemoved}
                onBlur={filesField.onBlur}
                error={filesField.error}
                disabled={pending}
              />
              <div className="form-actions">
                <Button type="submit" disabled={pending}>
                  {pending ? 'Uploading…' : 'Upload'}
                </Button>
              </div>
            </form>
          </section>
        </div>
        <div className="split-view-pane">
          <UploadQueue rows={queue} onClearFinished={handleClearFinished} />
        </div>
      </div>

      <Toolbar
        filters={
          <FilterBar label="Document filters" onClear={handleFilterClear} hasFilter={hasFilter}>
            <Select
              label="Ingestion status"
              options={INGESTION_STATUS_OPTIONS}
              value={appliedIngestionStatus}
              onChange={(value) => setUrlState({ ingestionStatus: value, skip: URL_DEFAULTS.skip })}
            />
          </FilterBar>
        }
        end={
          <span className="data-room-status">
            {/* Always mounted so the region registers on its own paint; empty until the first
                response names a count, rather than claiming "0 documents" while still loading. */}
            <span className="mono cell-sub" role="status">
              {documents !== null && `${countText} · ${statusLabel}`}
            </span>
            {documents !== null && statusDetail && (
              <span className="cell-sub data-room-status-detail">{statusDetail}</span>
            )}
            {!isDefaultView && (
              <Button variant="ghost" size="sm" onClick={refetch}>
                Refresh
              </Button>
            )}
          </span>
        }
      />

      {error && <Alert tone="rejected">{error}</Alert>}

      {documents === null && !error && <Skeleton label="Loading documents…" variant="table" />}

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
          <Table
            caption="Documents uploaded to the data room, with their ingestion status."
            className="documents-grid"
          >
            <colgroup>
              <col />
              <col className="col-badge" />
              <col className="col-narrow" />
              <col className="col-slim" />
              <col className="col-slim" />
              <col className="col-slim" />
              <col className="col-narrow" />
              <col className="col-narrow" />
            </colgroup>
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
                <TableHeaderCell>Class</TableHeaderCell>
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Size</TableHeaderCell>
                <SortableHeaderCell<DocumentSortField>
                  field="createdAt"
                  label="Uploaded"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell>Actions</TableHeaderCell>
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
                      <Tooltip content={doc.title}>
                        <RowLink to={href}>
                          <span className="cell-truncate">{doc.title}</span>
                        </RowLink>
                      </Tooltip>
                    </TableCell>
                    <TableCell label="Ingestion">
                      <Badge tone={INGESTION_TONE[doc.currentVersion.ingestionStatus]}>
                        {INGESTION_LABEL[doc.currentVersion.ingestionStatus]}
                      </Badge>
                      {doc.currentVersion.ingestionFailureReason && (
                        <p className="cell-sub">
                          <Tooltip content={doc.currentVersion.ingestionFailureReason}>
                            <span className="cell-truncate" tabIndex={0}>
                              {doc.currentVersion.ingestionFailureReason}
                            </span>
                          </Tooltip>
                        </p>
                      )}
                    </TableCell>
                    <TableCell label="Source">
                      {doc.sourceKind}
                      <p className="cell-sub">
                        <Tooltip content={doc.mimeType}>
                          <span className="cell-truncate" tabIndex={0}>
                            {doc.mimeType}
                          </span>
                        </Tooltip>
                      </p>
                    </TableCell>
                    <TableCell label="Class">
                      <Tooltip content={SOURCE_CLASS_LABEL[doc.sourceClass]}>
                        <span className="cell-truncate" tabIndex={0}>
                          {SOURCE_CLASS_LABEL[doc.sourceClass]}
                        </span>
                      </Tooltip>
                    </TableCell>
                    <TableCell label="Version" className="cell-numeric">
                      v{doc.currentVersion.versionNumber}
                    </TableCell>
                    <TableCell label="Size" className="cell-numeric">
                      {formatBytes(doc.currentVersion.sizeBytes)}
                    </TableCell>
                    <TableCell label="Uploaded" className="cell-numeric">
                      <Timestamp value={doc.createdAt} />
                    </TableCell>
                    {/* The row itself leads to the workbench reader; this is the only path to the
                        document's own metadata and version history. */}
                    <TableCell label="Actions" className="cell-actions">
                      <div className="form-actions">
                        <LinkButton
                          to={`/documents/${doc.id}`}
                          variant="ghost"
                          size="sm"
                          aria-label={`Details, ${doc.title}`}
                        >
                          Details
                        </LinkButton>
                      </div>
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
          pageSize={limit}
          onSkipChange={(next) => setUrlState({ skip: String(next) })}
          onPageSizeChange={(next) => setUrlState({ limit: String(next), skip: URL_DEFAULTS.skip })}
        />
      )}
    </div>
  );
}
