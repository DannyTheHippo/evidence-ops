import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMe,
  listAnswers,
  listApprovals,
  listConflicts,
  listDocuments,
  listSources,
  type Answer,
  type AnswerRunStatus,
  type Me,
  type Source,
} from '../api/client';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import Skeleton from '../components/ui/Skeleton';

interface CountTileState {
  count: number | null;
  error: string | null;
}

const EMPTY_COUNT_TILE: CountTileState = { count: null, error: null };

type BadgeTone = 'verified' | 'caution' | 'info' | 'rejected' | 'neutral';

// A run still in flight or failed shows its run status, never a premature outcome — matches
// AnswersPage's own tone assignment for the same three non-completed states.
const RUN_STATUS_TONE: Record<Exclude<AnswerRunStatus, 'completed'>, BadgeTone> = {
  queued: 'neutral',
  running: 'info',
  failed: 'rejected',
};

interface SourcesTileState {
  sources: Source[] | null;
  error: string | null;
}

interface AnswersTileState {
  answers: Answer[] | null;
  error: string | null;
}

/** Maps an answer to the Badge tone/label the recent-answers row shows. All three completed
 * outcomes are equally valid results — `insufficient_evidence` is an honest abstention, not a
 * failure, so it never shares a tone with `failed`. An answer that has not finished its run shows
 * `runStatus` in place of an outcome, since there is no outcome to show yet. */
function outcomeBadge(answer: Answer): { tone: BadgeTone; label: string } {
  if (answer.runStatus !== 'completed') {
    return { tone: RUN_STATUS_TONE[answer.runStatus], label: answer.runStatus };
  }
  switch (answer.outcome?.kind) {
    case 'answered':
      return { tone: 'verified', label: 'answered' };
    case 'conflicting_evidence':
      return { tone: 'caution', label: 'conflicting evidence' };
    case 'insufficient_evidence':
      return { tone: 'info', label: 'insufficient evidence' };
    default:
      return { tone: 'neutral', label: answer.runStatus };
  }
}

function CountTile({
  to,
  label,
  loadingLabel,
  state,
}: {
  to: string;
  label: string;
  loadingLabel: string;
  state: CountTileState;
}) {
  return (
    <Link to={to} className="dashboard-tile">
      <span className="dashboard-tile-label">{label}</span>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {!state.error && state.count === null && <Skeleton label={loadingLabel} lines={1} />}
      {!state.error && state.count !== null && (
        <span className="dashboard-tile-value">{state.count}</span>
      )}
    </Link>
  );
}

function SourceHealthTile({ state }: { state: SourcesTileState }) {
  const failing = state.sources?.filter((source) => source.lastSyncError) ?? [];
  const enabledCount = state.sources?.filter((source) => source.enabled).length ?? 0;

  return (
    <Link to="/sources" className="dashboard-tile">
      <span className="dashboard-tile-label">Source health</span>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {!state.error && state.sources === null && (
        <Skeleton label="Loading source health…" lines={1} />
      )}
      {!state.error && state.sources !== null && failing.length > 0 && (
        <>
          <Badge tone="rejected">
            {failing.length} sync {failing.length === 1 ? 'error' : 'errors'}
          </Badge>
          <p className="cell-sub">{failing[0]?.lastSyncError}</p>
        </>
      )}
      {!state.error && state.sources !== null && failing.length === 0 && (
        <span className="dashboard-tile-value">{enabledCount}</span>
      )}
    </Link>
  );
}

export default function HomePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<CountTileState>(EMPTY_COUNT_TILE);
  const [conflicts, setConflicts] = useState<CountTileState>(EMPTY_COUNT_TILE);
  const [documents, setDocuments] = useState<CountTileState>(EMPTY_COUNT_TILE);
  const [sources, setSources] = useState<SourcesTileState>({ sources: null, error: null });
  const [answers, setAnswers] = useState<AnswersTileState>({ answers: null, error: null });

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch((err: unknown) => {
        setMeError(err instanceof Error ? err.message : 'Failed to load account');
      });
  }, []);

  // Passing `state: 'pending'` explicitly rather than relying on the endpoint's own pending
  // default, so the intent reads from this call site rather than from the API's behaviour.
  useEffect(() => {
    listApprovals({ state: 'pending' })
      .then(({ count }) => setApprovals({ count, error: null }))
      .catch((err: unknown) => {
        setApprovals({
          count: null,
          error: err instanceof Error ? err.message : 'Failed to load approvals',
        });
      });
  }, []);

  useEffect(() => {
    listConflicts({ status: 'open', limit: 1 })
      .then(({ count }) => setConflicts({ count, error: null }))
      .catch((err: unknown) => {
        setConflicts({
          count: null,
          error: err instanceof Error ? err.message : 'Failed to load conflicts',
        });
      });
  }, []);

  useEffect(() => {
    listDocuments()
      .then(({ count }) => setDocuments({ count, error: null }))
      .catch((err: unknown) => {
        setDocuments({
          count: null,
          error: err instanceof Error ? err.message : 'Failed to load documents',
        });
      });
  }, []);

  useEffect(() => {
    listSources()
      .then(({ docs }) => {
        // Rendering below filters and reads .length off this array unconditionally — a
        // malformed response must fail this tile here rather than throw during render and
        // take the rest of the dashboard down with it.
        if (!Array.isArray(docs)) throw new Error('Malformed sources response');
        setSources({ sources: docs, error: null });
      })
      .catch((err: unknown) => {
        setSources({
          sources: null,
          error: err instanceof Error ? err.message : 'Failed to load sources',
        });
      });
  }, []);

  useEffect(() => {
    listAnswers({ limit: 5 })
      .then(({ docs }) => {
        if (!Array.isArray(docs)) throw new Error('Malformed answers response');
        setAnswers({ answers: docs, error: null });
      })
      .catch((err: unknown) => {
        setAnswers({
          answers: null,
          error: err instanceof Error ? err.message : 'Failed to load recent answers',
        });
      });
  }, []);

  // A brand-new tenant has no documents, no sources, and no answers — the tile row and recent
  // answers list would show nothing but zeroes, so this replaces them with onboarding guidance
  // instead. Waits for all three signals to have actually loaded (rather than treating the
  // still-loading `null` state as "empty") so the dashboard never flashes onboarding first.
  const isEmptyTenant =
    documents.count === 0 &&
    sources.sources !== null &&
    sources.sources.length === 0 &&
    answers.answers !== null &&
    answers.answers.length === 0;

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Overview</span>
          <h1 className="page-title">Home</h1>
          <p className="page-sub">Where your evidence stands right now.</p>
        </div>
      </div>

      {isEmptyTenant ? (
        <EmptyState
          title="Nothing here yet"
          description="Connect a source or upload a document, then ask a question to get started."
          action={
            <div className="form-actions">
              <Link className="btn btn--primary" to="/sources">
                Connect a source
              </Link>
              <Link className="btn btn--secondary" to="/documents">
                Upload a document
              </Link>
            </div>
          }
        />
      ) : (
        <>
          <div className="dashboard-tiles">
            <CountTile
              to="/approvals"
              label="Pending approvals"
              loadingLabel="Loading pending approvals…"
              state={approvals}
            />
            <CountTile
              to="/conflicts"
              label="Open conflicts"
              loadingLabel="Loading open conflicts…"
              state={conflicts}
            />
            <CountTile
              to="/documents"
              label="Documents"
              loadingLabel="Loading documents…"
              state={documents}
            />
            <SourceHealthTile state={sources} />
          </div>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Recent answers</h2>
            </div>
            {answers.error && (
              <p className="error" role="alert">
                {answers.error}
              </p>
            )}
            {!answers.error && answers.answers === null && (
              <Skeleton label="Loading recent answers…" />
            )}
            {!answers.error && answers.answers !== null && answers.answers.length === 0 && (
              <p className="cell-sub">No answers yet.</p>
            )}
            {!answers.error && answers.answers !== null && answers.answers.length > 0 && (
              <ul className="dashboard-answers">
                {answers.answers.map((answer) => {
                  const badge = outcomeBadge(answer);
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
        </>
      )}

      <section className="card card--narrow dashboard-account">
        <div className="card-head">
          <h2 className="card-title">Account</h2>
        </div>
        {me && (
          <dl className="form">
            <div>
              <dt>Email</dt>
              <dd>{me.email}</dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>{new Date(me.createdAt).toLocaleDateString()}</dd>
            </div>
          </dl>
        )}
        {!me && !meError && <Skeleton label="Loading account…" lines={2} />}
        {meError && (
          <p className="error" role="alert">
            {meError}
          </p>
        )}
      </section>
    </div>
  );
}
