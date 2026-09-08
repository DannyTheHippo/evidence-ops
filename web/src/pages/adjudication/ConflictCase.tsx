import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { requestConflictResolution, type Conflict, type ConflictValue } from '../../api/client';
import ConflictValueCompare from '../../components/ConflictValueCompare';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import DescriptionList from '../../components/ui/DescriptionList';
import Timestamp from '../../components/ui/Timestamp';
import { notify } from '../../components/ui/toast';
import { conflictStatusTone } from '../../lib/adjudication-status';
import type { ResolvedVersion } from '../../lib/document-index';
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
}

/** The adjudication pane for one conflict: metric, spread, and the decision record read straight
 *  from `conflict.resolution` — the queue needs no second query for it. While the conflict is
 *  still open, `ConflictValueCompare` also renders a "Request resolution" action per value, primary
 *  on the policy's recommended winner only. */
export default function ConflictCase({ conflict, metricLabels, documentIndex }: ConflictCaseProps) {
  const navigate = useNavigate();
  const [resolvingFactId, setResolvingFactId] = useState<string | null>(null);
  const [pendingResolution, setPendingResolution] = useState<ConflictValue | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // Blocks a double submit between the confirm click and the re-render that disables
  // `ConfirmDialog`'s own buttons.
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
        <span className="mono">
          {conflict.magnitude} {conflict.magnitudeUnit}
        </span>
      ),
    },
    { term: 'Created', description: <Timestamp value={conflict.createdAt} /> },
    // Stale and unscorable both gate whether action is even possible, so their reasons render
    // untruncated rather than behind `.cell-truncate`'s hover-only title.
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
          'No decision yet — request a resolution to start one.'
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

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="card-title">{conflict.factKey.entity}</h2>
        <Badge tone={conflictStatusTone(conflict.status)}>{conflict.status}</Badge>
      </div>

      <DescriptionList columns={2} items={detailItems} />

      <ConflictValueCompare
        values={conflict.values}
        proposedWinnerFactId={conflict.proposedWinnerFactId}
        ruleFired={conflict.ruleFired}
        explanation={conflict.explanation}
        documentIndex={documentIndex}
        renderAction={
          conflict.status === 'open'
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
            ? `Request resolution using ${pendingResolution.value} ${pendingResolution.unit} as the winning value? This starts a workflow run that needs approval.`
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
