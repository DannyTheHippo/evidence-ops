import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  decideApproval,
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
  type EvidenceDocument,
  type Source,
  type WithCount,
} from '../api/client';
import ApprovalDecisionDialog from '../components/ApprovalDecisionDialog';
import Badge, { type BadgeTone } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import Dialog from '../components/ui/Dialog';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Skeleton from '../components/ui/Skeleton';
import { notify } from '../components/ui/toast';
import { answerBadge } from '../lib/answer-status';
import { metricLabel, useMetricLabels } from '../lib/metric-labels';
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
 * policy recommendation, which needs the value picker `ConflictsPage` holds). `onChanged` is the
 * page's own `load`, re-run after a decision persists so the queue reflects the server's state
 * rather than the stale item this row was rendered from. */
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

  const [targetApproval, setTargetApproval] = useState<Approval | null>(null);
  const [pendingDecision, setPendingDecision] = useState<ApprovalDecision | null>(null);

  const [pendingConflict, setPendingConflict] = useState<Conflict | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // Blocks a double submit between the confirm click and the re-render that disables
  // ConfirmDialog's own buttons, matching ConflictsPage.tsx's resolveInFlightRef.
  const resolveInFlightRef = useRef(false);

  const items: WorkQueueItem[] = [
    ...(approvals.docs ?? []).map((approval): WorkQueueItem => ({
      key: `approval-${approval.id}`,
      name: approval.summary,
      to: '/approvals',
      typeLabel: 'Approval',
      createdAt: approval.createdAt,
      kind: 'approval',
      approval,
    })),
    ...(conflicts.docs ?? []).map((conflict): WorkQueueItem => ({
      key: `conflict-${conflict.id}`,
      name: `${conflict.factKey.entity} — ${metricLabel(conflict.factKey.metric, metricLabels)} (${conflict.factKey.period})`,
      to: '/conflicts',
      typeLabel: 'Conflict',
      createdAt: conflict.createdAt,
      // ISO 8601 timestamps sort correctly as plain strings, so no Date parsing is needed here.
      kind: 'conflict',
      conflict,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  function openDecision(approval: Approval, decision: ApprovalDecision) {
    setTargetApproval(approval);
    setPendingDecision(decision);
  }

  async function handleConfirmDecision(decision: ApprovalDecision, reason: string | undefined) {
    if (!targetApproval) return;
    await decideApproval(targetApproval.id, decision, reason);
    notify(
      'success',
      decision === 'approved'
        ? 'Approved — the workflow resumes.'
        : 'Rejected — the workflow resumes.',
    );
    setPendingDecision(null);
    await onChanged();
  }

  function closeResolution() {
    setPendingConflict(null);
    setResolveError(null);
  }

  // Requests resolution using the conflict's own policy-recommended value — the row shows the
  // action only when one exists (`proposedWinnerFactId` set); a conflict with no recommendation
  // needs the value picker on ConflictsPage instead, which this compact row has no room for.
  async function confirmResolution() {
    if (!pendingConflict?.proposedWinnerFactId || resolveInFlightRef.current) return;
    resolveInFlightRef.current = true;
    setResolving(true);
    setResolveError(null);
    try {
      await requestConflictResolution(pendingConflict.id, pendingConflict.proposedWinnerFactId);
      notify('success', 'Resolution requested — a workflow run started and now needs approval.');
      setPendingConflict(null);
      await onChanged();
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
        <h2 className="card-title">Work queue</h2>
        {!approvals.error &&
          !conflicts.error &&
          (approvals.count !== null || conflicts.count !== null) && (
            <span className="card-meta card-meta--end">
              {approvals.count ?? 0} pending approvals · {conflicts.count ?? 0} open conflicts
            </span>
          )}
      </div>
      {approvals.error && (
        <p className="error" role="alert">
          {approvals.error}
        </p>
      )}
      {conflicts.error && (
        <p className="error" role="alert">
          {conflicts.error}
        </p>
      )}
      {(approvals.docs !== null || conflicts.docs !== null) && items.length === 0 && (
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
                    <Badge tone="caution">{item.typeLabel}</Badge>
                    {canDecideApprovals && (
                      <>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => openDecision(approval, 'approved')}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
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
            return (
              <li key={item.key} className="actionable-row">
                <Link to={item.to} className="actionable-row-name">
                  {item.name}
                </Link>
                <div className="form-actions">
                  <Badge tone="caution">{item.typeLabel}</Badge>
                  {conflict.proposedWinnerFactId && (
                    <Button
                      variant="secondary"
                      size="sm"
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
 * `SourceRow`, which mounts one instance per row for the same reason. `onChanged` runs after
 * every sync attempt, not only a successful one: `useSourceSync` absorbs its own failure into
 * `syncError` rather than rejecting, so there is no thrown value here to gate the reload on, and
 * reloading on a failed attempt is a harmless extra read rather than a wrong report. */
function SourceHealthRow({
  item,
  onChanged,
}: {
  item: Extract<CorpusHealthItem, { kind: 'source' }>;
  onChanged: () => Promise<void>;
}) {
  const { run, isPolling, starting, syncError, startSync } = useSourceSync();

  async function handleSync() {
    await startSync(item.source.id, item.source.name);
    await onChanged();
  }

  return (
    <li className="actionable-row">
      <span>
        <Link to={item.to} className="actionable-row-name">
          {item.name}
        </Link>
        <span className="card-meta"> — {item.detail}</span>
      </span>
      <div className="form-actions">
        <Badge tone={item.tone}>{item.typeLabel}</Badge>
        <Button variant="secondary" size="sm" disabled={starting} onClick={() => void handleSync()}>
          {starting ? 'Syncing…' : 'Sync now'}
        </Button>
        {run && (
          <Link to={`/workflow-runs/${run.id}`}>
            {isPolling && <span className="live-dot" />}
            {syncRunLabel(run)}
          </Link>
        )}
      </div>
      {syncError && (
        <p className="error" role="alert">
          {syncError}
        </p>
      )}
    </li>
  );
}

/** Uploads a new version onto a document already surfaced as broken — a failed ingestion or a
 * facts-failed extraction. Owns the file input, in-flight state and error display; the caller
 * owns closing (via `doc` going back to `null`) and re-running `load` through `onReplaced`. */
function ReplaceVersionDialog({
  doc,
  onClose,
  onReplaced,
}: {
  doc: EvidenceDocument | null;
  onClose: () => void;
  onReplaced: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);
  const bodyId = useId();

  function handleClose() {
    setFile(null);
    setError(null);
    onClose();
  }

  async function handleConfirm() {
    if (!doc || !file || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await uploadDocument(file, { documentId: doc.id });
      notify('success', `Replacement version uploaded for ${doc.title}.`);
      setFile(null);
      onClose();
      await onReplaced();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to upload replacement version');
    } finally {
      setBusy(false);
      submitInFlightRef.current = false;
    }
  }

  return (
    <Dialog
      open={doc !== null}
      onClose={handleClose}
      title="Replace document version"
      describedBy={bodyId}
    >
      <div className="form">
        <p id={bodyId}>{doc ? `Upload a new version of "${doc.title}".` : ''}</p>
        {/* Mirrors UPLOAD_EXTENSION_ALLOWLIST in documents.constant.ts — the nine kinds the
            upload gate accepts. A narrower list here hides formats the server would take. */}
        <Field label="File">
          {(inputProps) => (
            <input
              type="file"
              accept=".pdf,.docx,.xlsx,.pptx,.csv,.tsv,.txt,.md,.eml"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
              {...inputProps}
            />
          )}
        </Field>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button variant="primary" disabled={busy || !file} onClick={() => void handleConfirm()}>
            {busy ? 'Uploading…' : 'Upload'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={handleClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Failed ingestions, documents with no extracted facts, and failed syncs as one queue, the same
 * "specific item, not a count" shape as the work queue above. An ingestion failure has no other
 * alert anywhere in the app today — Data Room shows `ingestionStatus` per row, but only to someone
 * already browsing it — and `lastSyncError` is otherwise visible only on the Sources pages. Reads
 * the server's own status-filtered queries rather than scanning a fixed-size page client-side, so a
 * failure older than any window is still visible here.
 *
 * Tone separates the two kinds of item the queue lists. An ingestion or sync failure is `rejected`:
 * the evidence never landed. A `facts-failed` document is `caution`: its chunks are committed and
 * searchable, and answers citing them are honest — it carries no extracted facts, so it feeds
 * neither the fact store nor conflict detection. A shared `rejected` tone would read as "unusable",
 * which it is not.
 *
 * `needsOcrDocuments` surfaces as a count only, in the card head, not as itemized rows in the
 * queue below — a scanned PDF is a gap in the corpus to flag for attention, not the kind of
 * broken-ingest item the queue otherwise lists, and a tenant with a hundred scans should not push
 * every one of them into this list one row at a time. A `facts-failed` document is itemized instead
 * of counted: it carries the extractor's own reason, and re-running extraction is a per-document
 * action. The full, browsable set of either is the Data Room's own `ingestionStatus` filter
 * (`DocumentList.tsx`). */
function CorpusHealthSection({
  failedDocuments,
  failedSources,
  needsOcrDocuments,
  factsFailedDocuments,
  onChanged,
}: {
  failedDocuments: FetchState<EvidenceDocument>;
  failedSources: FetchState<Source>;
  needsOcrDocuments: FetchState<EvidenceDocument>;
  factsFailedDocuments: FetchState<EvidenceDocument>;
  onChanged: () => Promise<void>;
}) {
  const [pendingReplaceDocument, setPendingReplaceDocument] = useState<EvidenceDocument | null>(
    null,
  );

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
  ];

  const anyError =
    failedDocuments.error !== null ||
    failedSources.error !== null ||
    needsOcrDocuments.error !== null ||
    factsFailedDocuments.error !== null;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Corpus health</h2>
        {!anyError &&
          (failedDocuments.count !== null ||
            failedSources.count !== null ||
            needsOcrDocuments.count !== null ||
            factsFailedDocuments.count !== null) && (
            <span className="card-meta card-meta--end">
              {failedDocuments.count ?? 0} ingestion failures · {failedSources.count ?? 0} sync
              failures · {needsOcrDocuments.count ?? 0} need OCR · {factsFailedDocuments.count ?? 0}{' '}
              without extracted facts
            </span>
          )}
      </div>
      {failedDocuments.error && (
        <p className="error" role="alert">
          {failedDocuments.error}
        </p>
      )}
      {failedSources.error && (
        <p className="error" role="alert">
          {failedSources.error}
        </p>
      )}
      {needsOcrDocuments.error && (
        <p className="error" role="alert">
          {needsOcrDocuments.error}
        </p>
      )}
      {factsFailedDocuments.error && (
        <p className="error" role="alert">
          {factsFailedDocuments.error}
        </p>
      )}
      {(failedDocuments.docs !== null ||
        failedSources.docs !== null ||
        needsOcrDocuments.docs !== null ||
        factsFailedDocuments.docs !== null) &&
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
                <span>
                  <Link to={item.to} className="actionable-row-name">
                    {item.name}
                  </Link>
                  <span className="card-meta"> — {item.detail}</span>
                </span>
                <div className="form-actions">
                  <Badge tone={item.tone}>{item.typeLabel}</Badge>
                  <Button
                    variant="secondary"
                    size="sm"
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
        onReplaced={onChanged}
      />
    </section>
  );
}

function RecentAnswersSection({ answers }: { answers: FetchState<Answer> }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Recent answers</h2>
      </div>
      {answers.error && (
        <p className="error" role="alert">
          {answers.error}
        </p>
      )}
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
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </li>
            );
          })}
        </ul>
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
 * even if a step is completed outside this page (e.g. a source added from a direct link). */
function FirstRunChecklist({ steps }: { steps: ChecklistStep[] }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Get started</h2>
      </div>
      <ul className="actionable-list">
        {steps.map((step) => (
          <li key={step.key} className="actionable-row">
            <span className="actionable-row-name">{step.label}</span>
            {step.done ? (
              <Badge tone="verified">done</Badge>
            ) : (
              <Link to={step.to} className="btn btn--secondary btn--sm">
                {step.cta}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function HomePage() {
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
  const [documents, setDocuments] = useState<FetchState<EvidenceDocument>>({
    docs: null,
    count: null,
    error: null,
  });
  const [sources, setSources] = useState<FetchState<Source>>({
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
  const [needsOcrDocuments, setNeedsOcrDocuments] = useState<FetchState<EvidenceDocument>>({
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
  // Gates the whole page behind one `Skeleton` so every section mounts on the same tick rather
  // than each resolving on its own schedule. Only the first load holds this gate — a refresh
  // keeps the page's existing content on screen while it runs, per `refreshing` below.
  const [pageLoading, setPageLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Fires every section's fetch together and resolves them together via `Promise.allSettled`
  // rather than `Promise.all`, so one failing section reports its own error without blanking the
  // rest of the page. Passing `state: 'pending'` and `status: 'open'` explicitly rather than
  // relying on the approvals/conflicts endpoints' own defaults keeps the intent readable at this
  // call site rather than resting on the API's behaviour. The four `listDocuments` calls stay
  // separate — `ingestionStatus` takes a single value server-side, with no multi-value form, so
  // one call per status is the only shape the API accepts.
  const load = useCallback(() => {
    return Promise.allSettled([
      listApprovals({ state: 'pending', limit: 5 }),
      listConflicts({ status: 'open', limit: 5 }),
      listDocuments({ limit: 100 }),
      listSources({ limit: 100 }),
      listDocuments({ ingestionStatus: 'failed', limit: 100 }),
      listSources({ lastSyncStatus: 'failed', limit: 100 }),
      listDocuments({ ingestionStatus: 'needs-ocr', limit: 100 }),
      listDocuments({ ingestionStatus: 'facts-failed', limit: 100 }),
      listAnswers({ limit: 5 }),
    ]).then(
      ([
        approvalsResult,
        conflictsResult,
        documentsResult,
        sourcesResult,
        failedDocumentsResult,
        failedSourcesResult,
        needsOcrResult,
        factsFailedResult,
        answersResult,
      ]) => {
        setApprovals(toFetchState(approvalsResult, 'Failed to load approvals'));
        setConflicts(toFetchState(conflictsResult, 'Failed to load conflicts'));
        // Unfiltered — feeds only the first-run checklist and the empty-tenant check below, which
        // need the tenant's actual corpus shape rather than its failures. Corpus health reads its
        // own failed-only queries beneath, so this fetch's `count`/`docs` never doubles as a
        // failure signal.
        setDocuments(toFetchState(documentsResult, 'Failed to load documents'));
        setSources(toFetchState(sourcesResult, 'Failed to load sources'));
        // Corpus health reads the server's own failed-only filters rather than scanning a
        // fixed-size page client-side, so a failure older than any window is still visible here.
        setFailedDocuments(toFetchState(failedDocumentsResult, 'Failed to load documents'));
        setFailedSources(toFetchState(failedSourcesResult, 'Failed to load sources'));
        // Same server-side-filter reasoning as the failed-only fetch above — a count that never
        // falls out of view behind a fixed-size window.
        setNeedsOcrDocuments(toFetchState(needsOcrResult, 'Failed to load documents'));
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

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  // The checklist and the empty-tenant supersession below both wait for all three funnel signals
  // to have actually loaded, rather than treating a still-loading `null` as "not done yet", so the
  // page never flashes onboarding at a tenant that already has a corpus.
  const funnelLoaded = documents.count !== null && sources.count !== null && answers.count !== null;
  const hasCorpus = (documents.count ?? 0) > 0 || (sources.count ?? 0) > 0;
  const hasIngestedDocument = (documents.docs ?? []).some(
    (doc) => doc.currentVersion.ingestionStatus === 'completed',
  );
  const hasAnswer = (answers.count ?? 0) > 0;
  const isEmptyTenant =
    funnelLoaded && documents.count === 0 && sources.count === 0 && answers.count === 0;
  const funnelComplete = funnelLoaded && hasCorpus && hasIngestedDocument && hasAnswer;

  const steps: ChecklistStep[] = [
    {
      key: 'connect',
      label: 'Add a source or upload a document',
      done: hasCorpus,
      to: '/sources',
      cta: 'Add a source',
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
      to: '/ask',
      cta: 'Ask a question',
    },
  ];

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Overview</span>
          <h1 className="page-title">Home</h1>
          <p className="page-sub">Where your evidence stands right now.</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleRefresh()}
          disabled={pageLoading || refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {pageLoading ? (
        <Skeleton label="Loading your dashboard…" />
      ) : isEmptyTenant ? (
        <FirstRunChecklist steps={steps} />
      ) : (
        <>
          <WorkQueueSection approvals={approvals} conflicts={conflicts} onChanged={load} />
          <CorpusHealthSection
            failedDocuments={failedDocuments}
            failedSources={failedSources}
            needsOcrDocuments={needsOcrDocuments}
            factsFailedDocuments={factsFailedDocuments}
            onChanged={load}
          />
          <RecentAnswersSection answers={answers} />
          {funnelLoaded && !funnelComplete && <FirstRunChecklist steps={steps} />}
        </>
      )}
    </div>
  );
}
