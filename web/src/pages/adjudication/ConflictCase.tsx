import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { requestConflictResolution, type Conflict, type ConflictValue } from '../../api/client';
import ConflictValueCompare from '../../components/ConflictValueCompare';
import Alert from '../../components/ui/Alert';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import DescriptionList from '../../components/ui/DescriptionList';
import LinkButton from '../../components/ui/LinkButton';
import Timestamp from '../../components/ui/Timestamp';
import { notify } from '../../components/ui/toast';
import { conflictStatusTone } from '../../lib/adjudication-status';
import type { ResolvedVersion } from '../../lib/document-index';
import { formatValue } from '../../lib/format-value';
import { metricLabel } from '../../lib/metric-labels';

// A pane offers at most one primary action, never exactly one: promoting a value the policy did
// not actually recommend — no rule fired, or the recommended source has since been withdrawn —
// would manufacture a recommendation the system did not make.
function isPrimaryValue(conflict: Conflict, value: ConflictValue): boolean {
  return (
    !!conflict.ruleFired &&
    conflict.ruleFired !== 'none' &&
    value.factId === conflict.proposedWinnerFactId &&
    !value.withdrawn
  );
}

interface ConflictCaseProps {
  conflict: Conflict;
  metricLabels: Record<string, string>;
  documentIndex: Map<string, ResolvedVersion>;
  /** Set when an open conflict already has a pending resolution approval; suppresses the request
   *  action and links to that decision. */
  pendingApprovalId?: string;
}

/** The adjudication pane for one conflict: metric, spread, and the decision record read straight
 *  from `conflict.resolution` — the queue needs no second query for it. While the conflict is
 *  still open, `ConflictValueCompare` also renders a "Request resolution" action per value, primary
 *  on the policy's recommended winner only. The action is withheld from the two open conflicts the
 *  server refuses: an unscorable one, whose evidence no longer resolves, and one already waiting on
 *  a resolution approval — the Decision row says which, and links to the pending decision. */
export default function ConflictCase({
  conflict,
  metricLabels,
  documentIndex,
  pendingApprovalId,
}: ConflictCaseProps) {
  const navigate = useNavigate();
  const [resolvingFactId, setResolvingFactId] = useState<string | null>(null);
  const [pendingResolution, setPendingResolution] = useState<ConflictValue | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // Blocks a double submit between the confirm click and the re-render that marks
  // `ConfirmDialog`'s Confirm busy.
  const resolveInFlightRef = useRef(false);

  function openResolveDialog(value: ConflictValue) {
    setPendingResolution(value);
    setResolveError(null);
  }

  function closeResolveDialog() {
    setPendingResolution(null);
    setResolveError(null);
  }

  async function confirmResolve() {
    if (!pendingResolution || resolveInFlightRef.current) return;
    resolveInFlightRef.current = true;
    setResolvingFactId(pendingResolution.factId);
    setResolveError(null);
    try {
      const run = await requestConflictResolution(conflict.id, pendingResolution.factId);
      notify('success', 'Resolution requested — a workflow run started and now needs approval.');
      setPendingResolution(null);
      await navigate(`/workflow-runs/${run.id}`);
    } catch (err: unknown) {
      setResolveError(err instanceof Error ? err.message : 'Failed to request resolution');
    } finally {
      setResolvingFactId(null);
      resolveInFlightRef.current = false;
    }
  }

  const { resolution } = conflict;
  const detailItems = [
    {
      term: 'Metric',
      description: `${metricLabel(conflict.factKey.metric, metricLabels)} · ${conflict.factKey.period}`,
    },
    {
      term: 'Spread',
      description: (
        <span className="mono">{formatValue(conflict.magnitude, conflict.magnitudeUnit)}</span>
      ),
    },
    { term: 'Created', description: <Timestamp value={conflict.createdAt} /> },
    // Stale and unscorable both gate whether action is even possible, so their reasons render
    // untruncated in the pane rather than behind a truncated cell.
    ...(conflict.stale
      ? [
          {
            term: 'Stale',
            description: <p className="notice notice--warn">{conflict.staleReason}</p>,
          },
        ]
      : []),
    ...(conflict.unscorable
      ? [
          {
            term: 'Unscorable',
            description: <p className="notice notice--warn">{conflict.unscorableReason}</p>,
          },
        ]
      : []),
    {
      term: 'Decision',
      description:
        conflict.status === 'open' ? (
          pendingApprovalId ? (
            <>
              Resolution pending — awaiting approval.{' '}
              <LinkButton
                variant="secondary"
                size="sm"
                to={`/adjudication?kind=decisions&state=pending&selected=${pendingApprovalId}`}
              >
                Open the decision
              </LinkButton>
            </>
          ) : conflict.unscorable ? (
            'Not resolvable while its evidence is missing — restore the missing evidence, or dismiss the conflict.'
          ) : (
            'No decision yet — request a resolution to start one.'
          )
        ) : resolution ? (
          <>
            {resolution.outcome} by {resolution.decidedBy ?? 'policy'} on{' '}
            <Timestamp value={resolution.resolvedAt} />
            {resolution.reason && <p className="cell-sub">{resolution.reason}</p>}
            {resolution.ruleFired && (
              <p className="cell-sub">rule fired · {resolution.ruleFired}</p>
            )}
            {resolution.followedProposal !== undefined && (
              <p className="cell-sub">
                {resolution.followedProposal
                  ? 'followed the proposal'
                  : 'did not follow the proposal'}
              </p>
            )}
          </>
        ) : (
          'Recorded under Decisions.'
        ),
    },
  ];

  // Only a request the server can honour is offered: an unscorable conflict answers 500 and one
  // already awaiting approval answers 409.
  const canRequestResolution =
    conflict.status === 'open' && !conflict.unscorable && pendingApprovalId === undefined;

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="card-title">{conflict.factKey.entity}</h2>
        <Badge tone={conflictStatusTone(conflict.status)}>{conflict.status}</Badge>
      </div>

      <DescriptionList columns={2} items={detailItems} />

      {/* A request that fails after its dialog was dismissed has nowhere else to land — the pane
          carries the failure so the dismissal never reads as success. */}
      {pendingResolution === null && resolveError && <Alert tone="rejected">{resolveError}</Alert>}

      <ConflictValueCompare
        values={conflict.values}
        proposedWinnerFactId={conflict.proposedWinnerFactId}
        ruleFired={conflict.ruleFired}
        explanation={conflict.explanation}
        documentIndex={documentIndex}
        renderAction={
          canRequestResolution
            ? (value) => (
                <Button
                  variant={isPrimaryValue(conflict, value) ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={resolvingFactId === value.factId}
                  onClick={() => openResolveDialog(value)}
                >
                  {resolvingFactId === value.factId ? 'Requesting…' : 'Request resolution'}
                </Button>
              )
            : undefined
        }
      />

      <ConfirmDialog
        open={pendingResolution !== null}
        onClose={closeResolveDialog}
        title="Request resolution"
        body={
          pendingResolution
            ? `Request resolution using ${formatValue(pendingResolution.value, pendingResolution.unit)} as the winning value? This starts a workflow run that needs approval.`
            : ''
        }
        confirmLabel="Request resolution"
        busy={resolvingFactId !== null}
        error={resolveError ?? undefined}
        onConfirm={() => void confirmResolve()}
      />
    </div>
  );
}
