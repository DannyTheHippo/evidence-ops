import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listAnswers,
  listApprovals,
  listConflicts,
  listDocuments,
  listSources,
  type Answer,
  type Approval,
  type Conflict,
  type EvidenceDocument,
  type Source,
} from '../api/client';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import Skeleton from '../components/ui/Skeleton';
import { answerBadge } from '../lib/answer-status';

interface FetchState<T> {
  docs: T[] | null;
  count: number | null;
  error: string | null;
}

interface WorkQueueItem {
  key: string;
  name: string;
  to: string;
  typeLabel: string;
  createdAt: string;
}

/** Pending approvals and open conflicts as one queue rather than two boxes — both are the same
 * kind of thing to a reader: a specific item that needs a decision. Neither carries a per-item
 * route, so each row links to the list page that holds the decide/resolve control for it. */
function WorkQueueSection({
  approvals,
  conflicts,
}: {
  approvals: FetchState<Approval>;
  conflicts: FetchState<Conflict>;
}) {
  const items: WorkQueueItem[] = [
    ...(approvals.docs ?? []).map((approval) => ({
      key: `approval-${approval.id}`,
      name: approval.summary,
      to: '/approvals',
      typeLabel: 'Approval',
      createdAt: approval.createdAt,
    })),
    ...(conflicts.docs ?? []).map((conflict) => ({
      key: `conflict-${conflict.id}`,
      name: `${conflict.factKey.entity} — ${conflict.factKey.metric} (${conflict.factKey.period})`,
      to: '/conflicts',
      typeLabel: 'Conflict',
      createdAt: conflict.createdAt,
      // ISO 8601 timestamps sort correctly as plain strings, so no Date parsing is needed here.
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const loading = !approvals.docs && !conflicts.docs;

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
      {loading && !approvals.error && !conflicts.error && <Skeleton label="Loading work queue…" />}
      {!loading && items.length === 0 && (
        <EmptyState className="empty-state--inline" title="Nothing needs your attention" />
      )}
      {items.length > 0 && (
        <ul className="actionable-list">
          {items.map((item) => (
            <li key={item.key} className="actionable-row">
              <Link to={item.to} className="actionable-row-name">
                {item.name}
              </Link>
              <Badge tone="caution">{item.typeLabel}</Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface CorpusHealthItem {
  key: string;
  name: string;
  to: string;
  typeLabel: string;
  detail: string;
}

/** Failed ingestions and failed syncs as one queue, the same "specific item, not a count" shape as
 * the work queue above. An ingestion failure has no other alert anywhere in the app today — Data
 * Room shows `ingestionStatus` per row, but only to someone already browsing it — and
 * `lastSyncError` is otherwise visible only on the Sources pages. Reads the server's own
 * failed-only filters rather than scanning a fixed-size page client-side, so a failure older than
 * any window is still visible here.
 *
 * `needsOcrDocuments` surfaces as a count only, in the card head, not as itemized rows in the
 * queue below — a scanned PDF is a gap in the corpus to flag for attention, not the kind of
 * broken-ingest item the queue otherwise lists, and a tenant with a hundred scans should not push
 * every one of them into this list one row at a time. The full, browsable set is the Data Room's
 * own `ingestionStatus` filter (`DocumentList.tsx`). */
function CorpusHealthSection({
  failedDocuments,
  failedSources,
  needsOcrDocuments,
}: {
  failedDocuments: FetchState<EvidenceDocument>;
  failedSources: FetchState<Source>;
  needsOcrDocuments: FetchState<EvidenceDocument>;
}) {
  const items: CorpusHealthItem[] = [
    ...(failedDocuments.docs ?? []).map((doc) => ({
      key: `document-${doc.id}`,
      name: doc.title,
      to: `/documents/${doc.id}`,
      typeLabel: 'Ingestion failed',
      detail: doc.currentVersion.ingestionFailureReason ?? 'No reason recorded.',
    })),
    ...(failedSources.docs ?? []).map((source) => ({
      key: `source-${source.id}`,
      name: source.name,
      to: `/sources/${source.id}`,
      typeLabel: 'Sync failed',
      detail: source.lastSyncError ?? 'No reason recorded.',
    })),
  ];

  const loading = !failedDocuments.docs && !failedSources.docs && !needsOcrDocuments.docs;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Corpus health</h2>
        {!failedDocuments.error &&
          !failedSources.error &&
          !needsOcrDocuments.error &&
          (failedDocuments.count !== null ||
            failedSources.count !== null ||
            needsOcrDocuments.count !== null) && (
            <span className="card-meta card-meta--end">
              {failedDocuments.count ?? 0} ingestion failures · {failedSources.count ?? 0} sync
              failures · {needsOcrDocuments.count ?? 0} need OCR
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
      {loading && !failedDocuments.error && !failedSources.error && !needsOcrDocuments.error && (
        <Skeleton label="Loading corpus health…" />
      )}
      {!loading && items.length === 0 && (
        <EmptyState className="empty-state--inline" title="No failed ingestions or syncs" />
      )}
      {items.length > 0 && (
        <ul className="actionable-list">
          {items.map((item) => (
            <li key={item.key} className="actionable-row">
              <span>
                <Link to={item.to} className="actionable-row-name">
                  {item.name}
                </Link>
                <span className="card-meta"> — {item.detail}</span>
              </span>
              <Badge tone="rejected">{item.typeLabel}</Badge>
            </li>
          ))}
        </ul>
      )}
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
      {!answers.error && !answers.docs && <Skeleton label="Loading recent answers…" />}
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
  const [answers, setAnswers] = useState<FetchState<Answer>>({
    docs: null,
    count: null,
    error: null,
  });

  // Passing `state: 'pending'` explicitly rather than relying on the endpoint's own pending
  // default, so the intent reads from this call site rather than from the API's behaviour.
  useEffect(() => {
    listApprovals({ state: 'pending', limit: 5 })
      .then(({ docs, count }) => setApprovals({ docs, count, error: null }))
      .catch((err: unknown) => {
        setApprovals({
          docs: null,
          count: null,
          error: err instanceof Error ? err.message : 'Failed to load approvals',
        });
      });
  }, []);

  useEffect(() => {
    listConflicts({ status: 'open', limit: 5 })
      .then(({ docs, count }) => setConflicts({ docs, count, error: null }))
      .catch((err: unknown) => {
        setConflicts({
          docs: null,
          count: null,
          error: err instanceof Error ? err.message : 'Failed to load conflicts',
        });
      });
  }, []);

  // Unfiltered — feeds only the first-run checklist and the empty-tenant check below, which need
  // the tenant's actual corpus shape rather than its failures. Corpus health reads its own
  // failed-only queries beneath, so this fetch's `count`/`docs` never doubles as a failure signal.
  useEffect(() => {
    listDocuments({ limit: 100 })
      .then(({ docs, count }) => setDocuments({ docs, count, error: null }))
      .catch((err: unknown) => {
        setDocuments({
          docs: null,
          count: null,
          error: err instanceof Error ? err.message : 'Failed to load documents',
        });
      });
  }, []);

  useEffect(() => {
    listSources({ limit: 100 })
      .then(({ docs, count }) => setSources({ docs, count, error: null }))
      .catch((err: unknown) => {
        setSources({
          docs: null,
          count: null,
          error: err instanceof Error ? err.message : 'Failed to load sources',
        });
      });
  }, []);

  // Corpus health reads the server's own failed-only filters rather than scanning a fixed-size
  // page client-side, so a failure older than any window is still visible here.
  useEffect(() => {
    listDocuments({ ingestionStatus: 'failed', limit: 100 })
      .then(({ docs, count }) => setFailedDocuments({ docs, count, error: null }))
      .catch((err: unknown) => {
        setFailedDocuments({
          docs: null,
          count: null,
          error: err instanceof Error ? err.message : 'Failed to load documents',
        });
      });
  }, []);

  useEffect(() => {
    listSources({ lastSyncStatus: 'failed', limit: 100 })
      .then(({ docs, count }) => setFailedSources({ docs, count, error: null }))
      .catch((err: unknown) => {
        setFailedSources({
          docs: null,
          count: null,
          error: err instanceof Error ? err.message : 'Failed to load sources',
        });
      });
  }, []);

  // Same server-side-filter reasoning as the failed-only fetch above — a count that never falls
  // out of view behind a fixed-size window.
  useEffect(() => {
    listDocuments({ ingestionStatus: 'needs-ocr', limit: 100 })
      .then(({ docs, count }) => setNeedsOcrDocuments({ docs, count, error: null }))
      .catch((err: unknown) => {
        setNeedsOcrDocuments({
          docs: null,
          count: null,
          error: err instanceof Error ? err.message : 'Failed to load documents',
        });
      });
  }, []);

  useEffect(() => {
    listAnswers({ limit: 5 })
      .then(({ docs, count }) => setAnswers({ docs, count, error: null }))
      .catch((err: unknown) => {
        setAnswers({
          docs: null,
          count: null,
          error: err instanceof Error ? err.message : 'Failed to load recent answers',
        });
      });
  }, []);

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
      </div>

      {isEmptyTenant ? (
        <FirstRunChecklist steps={steps} />
      ) : (
        <>
          <WorkQueueSection approvals={approvals} conflicts={conflicts} />
          <CorpusHealthSection
            failedDocuments={failedDocuments}
            failedSources={failedSources}
            needsOcrDocuments={needsOcrDocuments}
          />
          <RecentAnswersSection answers={answers} />
          {funnelLoaded && !funnelComplete && <FirstRunChecklist steps={steps} />}
        </>
      )}
    </div>
  );
}
