import { useCallback, useEffect, useId, useRef, useState, type Ref } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  decideApproval,
  getDashboardSummary,
  listAnswers,
  listApprovals,
  listConflicts,
  listDocuments,
  listSources,
  requestConflictResolution,
  uploadDocument,
  type Answer,
  type Approval,
  type ApprovalDecision,
  type Conflict,
  type DashboardSummary,
  type EvidenceDocument,
  type Source,
  type WithCount,
} from '../api/client';
import ApprovalDecisionDialog from '../components/ApprovalDecisionDialog';
import { IconCheck } from '../components/icons';
import Alert from '../components/ui/Alert';
import Badge, { type BadgeTone } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import Dialog from '../components/ui/Dialog';
import EmptyState from '../components/ui/EmptyState';
import FileInput from '../components/ui/FileInput';
import LinkButton from '../components/ui/LinkButton';
import PageHeader from '../components/ui/PageHeader';
import Skeleton from '../components/ui/Skeleton';
import Stat from '../components/ui/Stat';
import Timestamp from '../components/ui/Timestamp';
import Tooltip from '../components/ui/Tooltip';
import { notify } from '../components/ui/toast';
import { answerBadge } from '../lib/answer-status';
import { announce } from '../lib/announce';
import { metricLabel, useMetricLabels } from '../lib/metric-labels';
import { sourceStatus } from '../lib/source-status';
import { precheckUploadFile, UPLOAD_ACCEPT } from '../lib/upload-accept';
import { useFormSubmit } from '../lib/use-form-submit';
import { useAbortableEffect } from '../lib/use-latest';
import { invalidatePendingCounts } from '../lib/use-pending-counts';
import { useSession } from '../lib/use-session';
import { syncRunLabel, useSourceSync } from '../lib/use-source-sync';

interface FetchState<T> {
  docs: T[] | null;
  count: number | null;
  error: string | null;
}

/** Converts one leg of a `Promise.allSettled` batch into a `FetchState` — a rejection reports its
 * message where the underlying error carries one, and `fallbackError` names the section for every
 * other rejection shape (a thrown non-`Error`, a network failure with no message). */
function toFetchState<T>(
  result: PromiseSettledResult<WithCount<T>>,
  fallbackError: string,
): FetchState<T> {
  if (result.status === 'fulfilled') {
    return { docs: result.value.docs, count: result.value.count, error: null };
  }
  const reason: unknown = result.reason;
  return {
    docs: null,
    count: null,
    error: reason instanceof Error ? reason.message : fallbackError,
  };
}

interface SummaryState {
  data: DashboardSummary | null;
  error: string | null;
}

/** Same shape as `toFetchState` for the one-off `getDashboardSummary()` call, which returns a
 * single object rather than a `WithCount` page. */
function toSummaryState(result: PromiseSettledResult<DashboardSummary>): SummaryState {
  if (result.status === 'fulfilled') {
    return { data: result.value, error: null };
  }
  const reason: unknown = result.reason;
  return {
    data: null,
    error: reason instanceof Error ? reason.message : 'Failed to load dashboard summary',
  };
}

interface FailureEntry {
  label: string;
  message: string;
}

/** Names every failed leg of a section's `Promise.allSettled` batch inside one alert, rather than
 * stacking one `role="alert"` per leg — a tenant whose approvals and conflicts both fail to load
 * sees one banner naming both, not two identical-looking alerts. Labels are deduped for the
 * headline (two document-status queries both read as "documents") while every underlying message
 * still renders, so no failure detail is lost to the consolidation. `onRetry` re-runs the page's
 * own `load`, since a failed leg carries no state of its own to retry independently. */
function SectionAlert({ failures, onRetry }: { failures: FailureEntry[]; onRetry: () => void }) {
  if (failures.length === 0) return null;
  const labels = [...new Set(failures.map((failure) => failure.label))].join(', ');

  return (
    <Alert
      tone="rejected"
      action={
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      <p>
        Couldn't load: {labels}
        {failures.map((failure, index) => (
          <span key={`${failure.label}-${index}`} className="cell-sub">
            {' '}
            — {failure.message}
          </span>
        ))}
      </p>
    </Alert>
  );
}

type WorkQueueItem =
  | {
      key: string;
      name: string;
      to: string;
      typeLabel: string;
      createdAt: string;
      kind: 'approval';
      approval: Approval;
    }
  | {
      key: string;
      name: string;
      to: string;
      typeLabel: string;
      createdAt: string;
      kind: 'conflict';
      conflict: Conflict;
    };

/** Pending approvals and open conflicts as one queue rather than two boxes — both are the same
 * kind of thing to a reader: a specific item that needs a decision. Each row also carries the
 * control that decides it, so the item can be cleared without leaving Home; the row still links
 * to the list page for anything the inline control does not cover (e.g. a conflict with no
 * policy recommendation, which needs the value picker `AdjudicationPage` holds). `onChanged` is the
 * page's own `load`, re-run after a decision persists so the queue reflects the server's state
 * rather than the stale item this row was rendered from.
 *
 * Approval and conflict rows carry different badge tones — `info` for an approval (a process
 * state awaiting a decision) and `caution` for a conflict (data actually in contention) — so the
 * two kinds of row read as distinct at a glance rather than identical boxes with different text. */
function WorkQueueSection({
  approvals,
  conflicts,
  onChanged,
}: {
  approvals: FetchState<Approval>;
  conflicts: FetchState<Conflict>;
  onChanged: () => Promise<void>;
}) {
  const metricLabels = useMetricLabels();
  const session = useSession();
  // Fails CLOSED on the still-loading probe too, matching SourcesPage.tsx's canManage — a member
  // (or a session that hasn't resolved yet) never sees the decide controls flash in before the
  // check lands. The server's RolesGuard on POST /approvals/:id/decision is the actual boundary.
  const canDecideApprovals = session.status === 'authed' && session.me.role === 'admin';
  // Post-action focus target: the dialog's own focus-restore effect (use-modal-dialog.ts) points
  // at the row's decide button, which the subsequent `onChanged()` reload just removed — landing
  // there would drop a keyboard operator to <body>. The heading survives the reload.
  const headingRef = useRef<HTMLHeadingElement>(null);

  const [targetApproval, setTargetApproval] = useState<Approval | null>(null);
  const [pendingDecision, setPendingDecision] = useState<ApprovalDecision | null>(null);

  const [pendingConflict, setPendingConflict] = useState<Conflict | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // Blocks a double submit between the confirm click and the re-render that disables
  // ConfirmDialog's own buttons, the same double-submit guard a conflict resolution request uses
  // elsewhere in the app.
  const resolveInFlightRef = useRef(false);

  const items: WorkQueueItem[] = [
    ...(approvals.docs ?? []).map((approval): WorkQueueItem => ({
      key: `approval-${approval.id}`,
      name: approval.summary,
      to: `/adjudication?kind=decisions&state=pending&selected=${approval.id}`,
      typeLabel: 'Approval',
      createdAt: approval.createdAt,
      kind: 'approval',
      approval,
    })),
    ...(conflicts.docs ?? []).map((conflict): WorkQueueItem => ({
      key: `conflict-${conflict.id}`,
      name: `${conflict.factKey.entity} — ${metricLabel(conflict.factKey.metric, metricLabels)} (${conflict.factKey.period})`,
      to: `/adjudication?kind=conflicts&status=open&selected=${conflict.id}`,
      typeLabel: 'Conflict',
      createdAt: conflict.createdAt,
      // ISO 8601 timestamps sort correctly as plain strings, so no Date parsing is needed here.
      kind: 'conflict',
      conflict,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const failures: FailureEntry[] = [
    ...(approvals.error ? [{ label: 'approvals', message: approvals.error }] : []),
    ...(conflicts.error ? [{ label: 'conflicts', message: conflicts.error }] : []),
  ];

  function openDecision(approval: Approval, decision: ApprovalDecision) {
    setTargetApproval(approval);
    setPendingDecision(decision);
  }

  async function handleConfirmDecision(decision: ApprovalDecision, reason: string | undefined) {
    if (!targetApproval) return;
    await decideApproval(targetApproval.id, decision, reason);
    // Matches what ApprovalDecisionDialog's own resumesWorkflow copy told the user before this
    // resolved — an approval created outside a workflow has no run to resume.
    const message = targetApproval.workflowId
      ? decision === 'approved'
        ? 'Approved — the workflow resumes.'
        : 'Rejected — the workflow resumes.'
      : decision === 'approved'
        ? 'Approved — the decision was recorded.'
        : 'Rejected — the decision was recorded.';
    notify('success', message);
    invalidatePendingCounts();
    setPendingDecision(null);
    await onChanged();
    // The rAF is load-bearing: use-modal-dialog.ts's cleanup restores focus to the invoking
    // button, when it held focus at open, from an effect that is not ordered against this `await`,
    // so a plain synchronous focus() here would race it and lose. Toaster drops the inner aria-live
    // on a success toast, so announce() carries the same outcome to a screen reader while the row
    // itself vanishes.
    requestAnimationFrame(() => headingRef.current?.focus());
    announce(message);
  }

  function closeResolution() {
    setPendingConflict(null);
    setResolveError(null);
  }

  // Requests resolution using the conflict's own policy-recommended value — the row shows the
  // action only when one exists (`proposedWinnerFactId` set); a conflict with no recommendation
  // needs the value picker on AdjudicationPage instead, which this compact row has no room for.
  async function confirmResolution() {
    if (!pendingConflict?.proposedWinnerFactId || resolveInFlightRef.current) return;
    resolveInFlightRef.current = true;
    setResolving(true);
    setResolveError(null);
    try {
      await requestConflictResolution(pendingConflict.id, pendingConflict.proposedWinnerFactId);
      const message = 'Resolution requested — a workflow run started and now needs approval.';
      notify('success', message);
      invalidatePendingCounts();
      setPendingConflict(null);
      await onChanged();
      requestAnimationFrame(() => headingRef.current?.focus());
      announce(message);
    } catch (err: unknown) {
      setResolveError(err instanceof Error ? err.message : 'Failed to request resolution');
    } finally {
      setResolving(false);
      resolveInFlightRef.current = false;
    }
  }

  const winningValue = pendingConflict?.values.find(
    (value) => value.factId === pendingConflict.proposedWinnerFactId,
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title" tabIndex={-1} ref={headingRef}>
          Work queue
        </h2>
      </div>
      <SectionAlert failures={failures} onRetry={() => void onChanged()} />
      {/* Gates on every leg having resolved with no error, not just one — `toFetchState` sets
          `docs: null` on a rejection, so `docs !== null` on both legs and `failures.length === 0`
          are equivalent today; both are written so a later change to `toFetchState` that keeps
          stale docs alongside an error cannot silently reopen this gate. */}
      {approvals.docs !== null &&
        conflicts.docs !== null &&
        failures.length === 0 &&
        items.length === 0 && (
          <EmptyState className="empty-state--inline" title="Nothing needs your attention" />
        )}
      {items.length > 0 && (
        <ul className="actionable-list">
          {items.map((item) => {
            if (item.kind === 'approval') {
              const approval = item.approval;
              return (
                <li key={item.key} className="actionable-row">
                  <Link to={item.to} className="actionable-row-name">
                    {item.name}
                  </Link>
                  <div className="form-actions">
                    <span className="card-meta">
                      <Timestamp value={item.createdAt} />
                    </span>
                    <Badge tone="info">{item.typeLabel}</Badge>
                    {canDecideApprovals && (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Approve, ${approval.summary}`}
                          onClick={() => openDecision(approval, 'approved')}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Reject, ${approval.summary}`}
                          onClick={() => openDecision(approval, 'rejected')}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            }
            const conflict = item.conflict;
            // Gated on the recommended value actually being present, not merely on
            // `proposedWinnerFactId` being set — a dangling id (recommended winner withdrawn or
            // otherwise absent from `values`) would otherwise open a confirm dialog with an empty
            // body and post an id the server can no longer resolve.
            const recommended = conflict.values.find(
              (value) => value.factId === conflict.proposedWinnerFactId,
            );
            return (
              <li key={item.key} className="actionable-row">
                <Link to={item.to} className="actionable-row-name">
                  {item.name}
                </Link>
                <div className="form-actions">
                  <span className="card-meta">
                    <Timestamp value={item.createdAt} />
                  </span>
                  <Badge tone="caution">{item.typeLabel}</Badge>
                  {recommended && (
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`Request resolution, ${item.name}`}
                      onClick={() => setPendingConflict(conflict)}
                    >
                      Request resolution
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {approvals.count !== null &&
        approvals.docs !== null &&
        approvals.count > approvals.docs.length && (
          <p className="dashboard-more">
            <Link to="/adjudication?kind=decisions&state=pending">
              View all {approvals.count} pending approvals
            </Link>
          </p>
        )}
      {conflicts.count !== null &&
        conflicts.docs !== null &&
        conflicts.count > conflicts.docs.length && (
          <p className="dashboard-more">
            <Link to="/adjudication?kind=conflicts&status=open">
              View all {conflicts.count} open conflicts
            </Link>
          </p>
        )}
      <ApprovalDecisionDialog
        decision={pendingDecision}
        summary={targetApproval?.summary ?? ''}
        resumesWorkflow={!!targetApproval?.workflowId}
        onClose={() => setPendingDecision(null)}
        onConfirm={handleConfirmDecision}
      />
      <ConfirmDialog
        open={pendingConflict !== null}
        onClose={closeResolution}
        title="Request resolution"
        body={
          winningValue
            ? `Request resolution using ${winningValue.value} ${winningValue.unit} as the winning value? This starts a workflow run that needs approval.`
            : ''
        }
        confirmLabel="Request resolution"
        busy={resolving}
        error={resolveError ?? undefined}
        onConfirm={() => void confirmResolution()}
      />
    </section>
  );
}

type CorpusHealthItem =
  | {
      key: string;
      name: string;
      to: string;
      typeLabel: string;
      detail: string;
      tone: BadgeTone;
      kind: 'document';
      document: EvidenceDocument;
    }
  | {
      key: string;
      name: string;
      to: string;
      typeLabel: string;
      detail: string;
      tone: BadgeTone;
      kind: 'source';
      source: Source;
    };

/** One source row's own `useSourceSync` instance — a hook, so it needs a component of its own
 * rather than a branch inside the shared `.map()` below, matching `SourcesPage.tsx`'s
 * `SourceRow`, which mounts one instance per row for the same reason. `onChanged` is wired as
 * `onSettled`, so the parent list reloads once the sweep this row started actually reaches a
 * terminal state, not the instant the request to start it returns — a failed start never reaches
 * `waiting`, so it never triggers a reload at all, and `syncError` alone carries that failure. */
function SourceHealthRow({
  item,
  onChanged,
}: {
  item: Extract<CorpusHealthItem, { kind: 'source' }>;
  onChanged: () => Promise<void>;
}) {
  const { run, isPolling, starting, syncError, source, startSync } = useSourceSync(
    undefined,
    () => void onChanged(),
  );
  // `source` is the hook's own freshest poll read, which lands before the parent list's reload
  // does — falls back to the row's own `item.source` before any sweep has polled at all.
  const status = sourceStatus(source ?? item.source, isPolling);
  const detail = status.detail ?? 'No reason recorded.';

  return (
    <li className="actionable-row">
      <span className="actionable-row-text">
        <Link to={item.to} className="actionable-row-name">
          {item.name}
        </Link>{' '}
        —{' '}
        <Tooltip content={detail}>
          <span className="cell-sub cell-truncate" tabIndex={0}>
            {detail}
          </span>
        </Tooltip>
      </span>
      <div className="form-actions">
        <Badge tone={status.tone}>{status.label}</Badge>
        <Button
          variant="secondary"
          size="sm"
          busy={starting}
          busyLabel="Syncing…"
          aria-label={`Sync now, ${item.source.name}`}
          onClick={() => void startSync(item.source.id, item.source.name)}
        >
          Sync now
        </Button>
        {run && (
          <Link to={`/workflow-runs/${run.id}`}>
            {isPolling && <span className="live-dot" />}
            {syncRunLabel(run)}
          </Link>
        )}
      </div>
      {syncError && <Alert tone="rejected">{syncError}</Alert>}
    </li>
  );
}

/** The file input and its submit lifecycle for one open of the dialog. Mounted only while a
 * document is set — keyed by `doc.id` below — so a cancelled or failed attempt against one
 * document never carries its file, its field error or its submitted state into a later open for
 * a different document. Submit is gated on `validate()`, not on `disabled={!file}` — an empty
 * submit focuses the file input and shows an inline error instead of silently doing nothing. */
function ReplaceVersionForm({
  doc,
  bodyId,
  onClose,
  onReplaced,
}: {
  doc: EvidenceDocument;
  bodyId: string;
  onClose: () => void;
  onReplaced: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);

  const { pending, formError, onSubmit, fieldProps } = useFormSubmit<'file'>({
    validate: () => {
      if (!file) return { file: 'Choose a file to upload.' };
      const message = precheckUploadFile(file);
      return message ? { file: message } : {};
    },
    submit: async () => {
      await uploadDocument(file as File, { documentId: doc.id });
      notify('success', `Replacement version uploaded for ${doc.title}.`);
    },
    onSuccess: () => {
      onClose();
      void onReplaced();
    },
  });
  const { id: fileId, error: fileError, onBlur: fileBlur } = fieldProps('file');

  return (
    <form onSubmit={onSubmit} className="form" noValidate>
      <p id={bodyId}>{`Upload a new version of "${doc.title}".`}</p>
      <FileInput
        id={fileId}
        name="file"
        label="File"
        accept={UPLOAD_ACCEPT}
        files={file ? [{ file }] : []}
        onFilesAdded={(added) => setFile(added[0] ?? null)}
        onFileRemoved={() => setFile(null)}
        onBlur={fileBlur}
        error={fileError}
        disabled={pending}
      />
      {formError && <Alert tone="rejected">{formError}</Alert>}
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={pending} busyLabel="Uploading…">
          Upload
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Uploads a new version onto a document already surfaced as broken — a failed ingestion or a
 * facts-failed extraction. The caller owns closing (via `doc` going back to `null`) and
 * re-running `load` through `onReplaced`; the form lifecycle itself lives in
 * `ReplaceVersionForm`, mounted only while there is a document to act on. */
function ReplaceVersionDialog({
  doc,
  onClose,
  onReplaced,
}: {
  doc: EvidenceDocument | null;
  onClose: () => void;
  onReplaced: () => Promise<void>;
}) {
  const bodyId = useId();

  return (
    <Dialog
      open={doc !== null}
      onClose={onClose}
      title="Replace document version"
      describedBy={bodyId}
    >
      {doc && (
        <ReplaceVersionForm
          key={doc.id}
          doc={doc}
          bodyId={bodyId}
          onClose={onClose}
          onReplaced={onReplaced}
        />
      )}
    </Dialog>
  );
}

/** Failed ingestions, documents with no extracted facts, and failed syncs as one queue, the same
 * "specific item, not a count" shape as the work queue above. An ingestion failure has no other
 * alert anywhere in the app today — Data room shows `ingestionStatus` per row, but only to someone
 * already browsing it — and `lastSyncError` is otherwise visible only on the Sources pages. Reads
 * the server's own status-filtered queries rather than scanning a fixed-size page client-side, so a
 * failure older than any window is still visible here.
 *
 * Rows are severity-ordered — ingestion failures, then sync failures, then facts-failed documents —
 * rather than grouped by resource type, so the most serious items surface first regardless of
 * whether they are a document or a source. An ingestion failure reads `rejected` (the evidence
 * never landed); a sync failure and a `facts-failed` document both read `caution` — a sync failure
 * through `sourceStatus()`'s shared vocabulary (the evidence sits with the connector, waiting on a
 * retry, not lost), and `facts-failed` because its chunks are committed and searchable, and
 * answers citing them are honest — it just carries no extracted facts, feeding neither the fact
 * store nor conflict detection.
 *
 * `needsOcrCount` surfaces only in the stat row above, never as itemized rows here — a scanned PDF
 * is a gap in the corpus to flag for attention, not the kind of broken-ingest item this queue
 * otherwise lists, and a tenant with a hundred scans should not push every one of them into this
 * list one row at a time. The full, browsable set of any of these three is the Data room's own
 * `ingestionStatus` filter (`DocumentList.tsx`). */
function CorpusHealthSection({
  failedDocuments,
  failedSources,
  factsFailedDocuments,
  summary,
  onChanged,
  ref,
}: {
  failedDocuments: FetchState<EvidenceDocument>;
  failedSources: FetchState<Source>;
  factsFailedDocuments: FetchState<EvidenceDocument>;
  summary: DashboardSummary | null;
  onChanged: () => Promise<void>;
  ref?: Ref<HTMLElement>;
}) {
  const [pendingReplaceDocument, setPendingReplaceDocument] = useState<EvidenceDocument | null>(
    null,
  );
  // Post-action focus target — see WorkQueueSection's headingRef for why the heading, not the
  // row's own control, survives the reload that follows a replace.
  const headingRef = useRef<HTMLHeadingElement>(null);

  async function handleReplaced() {
    await onChanged();
    requestAnimationFrame(() => headingRef.current?.focus());
    announce('Replacement version uploaded — the corpus health list has been updated.');
  }

  const items: CorpusHealthItem[] = [
    ...(failedDocuments.docs ?? []).map((doc): CorpusHealthItem => ({
      key: `document-${doc.id}`,
      name: doc.title,
      to: `/documents/${doc.id}`,
      typeLabel: 'Ingestion failed',
      detail: doc.currentVersion.ingestionFailureReason ?? 'No reason recorded.',
      tone: 'rejected' as const,
      kind: 'document',
      document: doc,
    })),
    ...(failedSources.docs ?? []).map((source): CorpusHealthItem => ({
      key: `source-${source.id}`,
      name: source.name,
      to: `/sources/${source.id}`,
      typeLabel: 'Sync failed',
      detail: source.lastSyncError ?? 'No reason recorded.',
      tone: 'rejected' as const,
      kind: 'source',
      source,
    })),
    ...(factsFailedDocuments.docs ?? []).map((doc): CorpusHealthItem => ({
      key: `facts-failed-${doc.id}`,
      name: doc.title,
      to: `/documents/${doc.id}`,
      typeLabel: 'No facts extracted',
      detail: doc.currentVersion.ingestionFailureReason ?? 'No reason recorded.',
      tone: 'caution' as const,
      kind: 'document',
      document: doc,
    })),
  ];

  const failures: FailureEntry[] = [
    ...(failedDocuments.error ? [{ label: 'documents', message: failedDocuments.error }] : []),
    ...(failedSources.error ? [{ label: 'sources', message: failedSources.error }] : []),
    ...(factsFailedDocuments.error
      ? [{ label: 'documents', message: factsFailedDocuments.error }]
      : []),
  ];

  return (
    <section id="corpus-health" tabIndex={-1} ref={ref} className="card">
      <div className="card-head">
        <h2 className="card-title" tabIndex={-1} ref={headingRef}>
          Corpus health
        </h2>
        {summary && (
          <p className="dashboard-breakdown">
            <Link to="/documents?ingestionStatus=failed">
              {summary.ingestionFailedCount} ingestion
            </Link>
            {' · '}
            {summary.syncFailedCount} sync
            {' · '}
            <Link to="/documents?ingestionStatus=facts-failed">
              {summary.factsFailedCount} no facts
            </Link>
          </p>
        )}
      </div>
      <SectionAlert failures={failures} onRetry={() => void onChanged()} />
      {/* Same invariant as WorkQueueSection's gate: `toFetchState` sets `docs: null` on a
          rejection, so `docs !== null` on every leg and `failures.length === 0` are equivalent
          today; both are written to keep the gate honest if that changes. */}
      {failedDocuments.docs !== null &&
        failedSources.docs !== null &&
        factsFailedDocuments.docs !== null &&
        failures.length === 0 &&
        items.length === 0 && (
          <EmptyState
            className="empty-state--inline"
            title="No ingestion, extraction or sync failures"
          />
        )}
      {items.length > 0 && (
        <ul className="actionable-list">
          {items.map((item) => {
            if (item.kind === 'source') {
              return <SourceHealthRow key={item.key} item={item} onChanged={onChanged} />;
            }
            const document = item.document;
            return (
              <li key={item.key} className="actionable-row">
                <span className="actionable-row-text">
                  <Link to={item.to} className="actionable-row-name">
                    {item.name}
                  </Link>{' '}
                  —{' '}
                  <Tooltip content={item.detail}>
                    <span className="cell-sub cell-truncate" tabIndex={0}>
                      {item.detail}
                    </span>
                  </Tooltip>
                </span>
                <div className="form-actions">
                  <Badge tone={item.tone}>{item.typeLabel}</Badge>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Replace version, ${document.title}`}
                    onClick={() => setPendingReplaceDocument(document)}
                  >
                    Replace version
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ReplaceVersionDialog
        doc={pendingReplaceDocument}
        onClose={() => setPendingReplaceDocument(null)}
        onReplaced={handleReplaced}
      />
    </section>
  );
}

function RecentAnswersSection({
  answers,
  onChanged,
}: {
  answers: FetchState<Answer>;
  onChanged: () => Promise<void>;
}) {
  const failures: FailureEntry[] = answers.error
    ? [{ label: 'answers', message: answers.error }]
    : [];

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Recent answers</h2>
      </div>
      <SectionAlert failures={failures} onRetry={() => void onChanged()} />
      {!answers.error && answers.docs && answers.docs.length === 0 && (
        <EmptyState className="empty-state--inline" title="No answers yet" />
      )}
      {!answers.error && answers.docs && answers.docs.length > 0 && (
        <ul className="dashboard-answers">
          {answers.docs.map((answer) => {
            const badge = answerBadge(answer);
            return (
              <li key={answer.id} className="dashboard-answer">
                <Link to={`/answers/${answer.id}`} className="dashboard-answer-question">
                  {answer.questionText}
                </Link>
                <div className="form-actions">
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                  <span className="card-meta">
                    <Timestamp value={answer.createdAt} />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {answers.count !== null && answers.docs !== null && answers.count > answers.docs.length && (
        <p className="dashboard-more">
          <Link to="/answers">View all {answers.count} answers</Link>
        </p>
      )}
    </section>
  );
}

interface ChecklistStep {
  key: string;
  label: string;
  done: boolean;
  to: string;
  cta: string;
}

/** The guided first-run path: connect evidence, wait for it to ingest, ask a question. Each step
 * marks done from a live signal rather than a stored flag, so it reflects the tenant's actual state
 * even if a step is completed outside this page (e.g. a source added from a direct link). Rendered
 * as an ordered list so the browser announces each step's position for free; the marker itself
 * (a number, or a check once done) is `aria-hidden` and purely visual. Exactly one step — the
 * first undone one — carries the primary button, since this section holds the page's only primary
 * action whenever it renders. */
function FirstRunChecklist({ steps }: { steps: ChecklistStep[] }) {
  const firstUndoneIndex = steps.findIndex((step) => !step.done);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Get started</h2>
      </div>
      <ol className="stepper">
        {steps.map((step, index) => (
          <li key={step.key} className={`stepper-step${step.done ? ' is-done' : ''}`}>
            <span className="stepper-marker" aria-hidden="true">
              {step.done ? <IconCheck size={14} /> : index + 1}
            </span>
            <span className="stepper-label">{step.label}</span>
            {step.done ? (
              <Badge tone="verified">Done</Badge>
            ) : (
              <LinkButton
                to={step.to}
                variant={index === firstUndoneIndex ? 'primary' : 'secondary'}
                size="sm"
              >
                {step.cta}
              </LinkButton>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function HomePage() {
  const [summary, setSummary] = useState<SummaryState>({ data: null, error: null });
  const [approvals, setApprovals] = useState<FetchState<Approval>>({
    docs: null,
    count: null,
    error: null,
  });
  const [conflicts, setConflicts] = useState<FetchState<Conflict>>({
    docs: null,
    count: null,
    error: null,
  });
  const [failedDocuments, setFailedDocuments] = useState<FetchState<EvidenceDocument>>({
    docs: null,
    count: null,
    error: null,
  });
  const [failedSources, setFailedSources] = useState<FetchState<Source>>({
    docs: null,
    count: null,
    error: null,
  });
  const [factsFailedDocuments, setFactsFailedDocuments] = useState<FetchState<EvidenceDocument>>({
    docs: null,
    count: null,
    error: null,
  });
  const [answers, setAnswers] = useState<FetchState<Answer>>({
    docs: null,
    count: null,
    error: null,
  });
  // Gates the whole page behind one loading region so every section mounts on the same tick
  // rather than each resolving on its own schedule. Only the first load holds this gate — a
  // refresh keeps the page's existing content on screen while it runs, per `refreshing` below.
  const [pageLoading, setPageLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const location = useLocation();
  const corpusRef = useRef<HTMLElement>(null);
  const session = useSession();
  // Lives in `load` rather than the mount effect because `load` has three callers — the mount
  // effect, `Refresh`, and every row's `onChanged` — and a token in only one of them would leave
  // the other two racing a stale response back onto the page.
  const loadSeqRef = useRef(0);

  // Fires every section's fetch together and resolves them together via `Promise.allSettled`
  // rather than `Promise.all`, so one failing section reports its own error without blanking the
  // rest of the page. `getDashboardSummary()` carries every count the stat row and the first-run
  // checklist need, computed server-side across the tenant's whole corpus rather than a
  // client-side scan of a fixed-size page. `failedDocuments`/`failedSources`/`factsFailedDocuments`
  // read the server's own status-filtered queries, since corpus health itemizes those rows rather
  // than only counting them. The two `listDocuments` calls stay separate — `ingestionStatus` takes
  // a single value server-side, with no multi-value form.
  const load = useCallback((isCurrent?: () => boolean) => {
    const seq = ++loadSeqRef.current;
    return Promise.allSettled([
      getDashboardSummary(),
      listApprovals({ state: 'pending', limit: 5 }),
      listConflicts({ status: 'open', limit: 5 }),
      listDocuments({ ingestionStatus: 'failed', limit: 100 }),
      listSources({ lastSyncStatus: 'failed', limit: 100 }),
      listDocuments({ ingestionStatus: 'facts-failed', limit: 100 }),
      listAnswers({ limit: 5 }),
    ]).then(
      ([
        summaryResult,
        approvalsResult,
        conflictsResult,
        failedDocumentsResult,
        failedSourcesResult,
        factsFailedResult,
        answersResult,
      ]) => {
        // A superseded call (a newer `load` already started, or the effect that started this one
        // has since unmounted) must never restore state a later call has already moved past.
        if (seq !== loadSeqRef.current || isCurrent?.() === false) return;
        setSummary(toSummaryState(summaryResult));
        setApprovals(toFetchState(approvalsResult, 'Failed to load approvals'));
        setConflicts(toFetchState(conflictsResult, 'Failed to load conflicts'));
        setFailedDocuments(toFetchState(failedDocumentsResult, 'Failed to load documents'));
        setFailedSources(toFetchState(failedSourcesResult, 'Failed to load sources'));
        // A 'facts-failed' version is searchable and answerable while carrying no extracted
        // facts, so nothing else on this page would report it — it is not a 'failed' ingestion
        // and its document reads as healthy everywhere the status is not shown.
        setFactsFailedDocuments(toFetchState(factsFailedResult, 'Failed to load documents'));
        setAnswers(toFetchState(answersResult, 'Failed to load recent answers'));
        // Set unconditionally rather than only on the first call — a no-op once the initial load
        // has already cleared the gate, and what clears it the one time that matters.
        setPageLoading(false);
      },
    );
  }, []);

  // Adopts the mount-effect half of the same guard: an unmount mid-load must drop the response
  // too, which a sequence token alone does not cover. `load` must never be passed directly as an
  // event handler elsewhere — the event object would arrive as `isCurrent`.
  useAbortableEffect((isCurrent) => load(isCurrent), [load]);

  useEffect(() => {
    if (location.hash === '#corpus-health') {
      corpusRef.current?.scrollIntoView({ block: 'start' });
      corpusRef.current?.focus();
    }
  }, [location.key, location.hash, pageLoading]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const data = summary.data;
  // `funnelLoaded` gates on the summary having actually resolved, not on any individual count —
  // a failed summary fetch must not let a `null`-coerced-to-zero count masquerade as a genuinely
  // empty or complete tenant, which is why both the empty-tenant supersession and the Get started
  // section below stay hidden while it is false.
  const funnelLoaded = data !== null;
  const hasCorpus = (data?.documentCount ?? 0) > 0 || (data?.sourceCount ?? 0) > 0;
  const hasIngestedDocument = data?.hasIngestedDocument ?? false;
  const hasAnswer = (data?.answerCount ?? 0) > 0;
  const isEmptyTenant =
    funnelLoaded && data.documentCount === 0 && data.sourceCount === 0 && data.answerCount === 0;
  const funnelComplete = funnelLoaded && hasCorpus && hasIngestedDocument && hasAnswer;

  // Failing toward the member destination is the closed direction here: document upload is open
  // to every role, source creation is not, so an unresolved (`loading`) session must never grant
  // the admin-only step early.
  const isAdmin = session.status === 'authed' && session.me.role === 'admin';

  const steps: ChecklistStep[] = [
    {
      key: 'connect',
      label: 'Add a source or upload a document',
      done: hasCorpus,
      to: isAdmin ? '/sources' : '/documents',
      cta: isAdmin ? 'Add a source' : 'Upload a document',
    },
    {
      key: 'ingest',
      label: 'Wait for ingestion to complete',
      done: hasIngestedDocument,
      to: '/documents',
      cta: 'View documents',
    },
    {
      key: 'ask',
      label: 'Ask a question',
      done: hasAnswer,
      to: '/answers',
      cta: 'Ask a question',
    },
  ];

  const failuresSum = data
    ? data.ingestionFailedCount + data.syncFailedCount + data.factsFailedCount
    : null;

  return (
    <div className="view">
      <PageHeader
        eyebrow="Overview"
        title="Home"
        description="Where your evidence stands right now."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleRefresh()}
            busy={pageLoading || refreshing}
            busyLabel="Refreshing…"
          >
            Refresh
          </Button>
        }
      />

      {pageLoading ? (
        <div className="dashboard-skeleton">
          <Skeleton label="Loading your dashboard…" variant="form" lines={4} />
          <div className="card" aria-hidden="true">
            <div className="skeleton-table">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="skeleton-row" />
              ))}
            </div>
          </div>
          <div className="card" aria-hidden="true">
            <div className="skeleton-table">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="skeleton-row" />
              ))}
            </div>
          </div>
          <div className="card" aria-hidden="true">
            <div className="skeleton-table">
              {Array.from({ length: 2 }, (_, i) => (
                <div key={i} className="skeleton-row" />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {summary.error && (
            <Alert
              tone="rejected"
              action={
                <Button variant="ghost" size="sm" onClick={() => void handleRefresh()}>
                  Retry
                </Button>
              }
            >
              Couldn't load the dashboard summary — {summary.error}
            </Alert>
          )}
          <div className="stat-row">
            <Stat
              label="Pending approvals"
              value={data ? data.pendingApprovalCount : '—'}
              tone={data ? (data.pendingApprovalCount > 0 ? 'caution' : 'neutral') : 'neutral'}
              hint={data ? undefined : 'unavailable'}
              to="/adjudication?kind=decisions&state=pending"
            />
            <Stat
              label="Open conflicts"
              value={data ? data.openConflictCount : '—'}
              tone={data ? (data.openConflictCount > 0 ? 'caution' : 'neutral') : 'neutral'}
              hint={data ? undefined : 'unavailable'}
              to="/adjudication?kind=conflicts&status=open"
            />
            <Stat
              label="Corpus failures"
              value={data ? (failuresSum ?? 0) : '—'}
              tone={data ? ((failuresSum ?? 0) > 0 ? 'rejected' : 'neutral') : 'neutral'}
              hint={
                data
                  ? `${data.ingestionFailedCount} ingestion · ${data.syncFailedCount} sync · ${data.factsFailedCount} facts`
                  : 'unavailable'
              }
              to="#corpus-health"
            />
            <Stat
              label="Needs OCR"
              value={data ? data.needsOcrCount : '—'}
              tone="neutral"
              hint={data ? undefined : 'unavailable'}
              to="/documents?ingestionStatus=needs-ocr"
            />
          </div>

          {isEmptyTenant ? (
            <FirstRunChecklist steps={steps} />
          ) : (
            <>
              {/* Above Work queue whenever it renders — the checklist holds the page's only
                  primary action while the funnel is incomplete, and that outranks the queue. */}
              {funnelLoaded && !funnelComplete && <FirstRunChecklist steps={steps} />}
              <WorkQueueSection approvals={approvals} conflicts={conflicts} onChanged={load} />
              <CorpusHealthSection
                failedDocuments={failedDocuments}
                failedSources={failedSources}
                factsFailedDocuments={factsFailedDocuments}
                summary={data}
                onChanged={load}
                ref={corpusRef}
              />
              <RecentAnswersSection answers={answers} onChanged={load} />
            </>
          )}
        </>
      )}
    </div>
  );
}
