import { useMemo, useState } from 'react';
import {
  applyHarvestedAlias,
  revokeHarvestedAlias,
  scanNearMatches,
  type CanonicalEntity,
  type HarvestedAlias,
} from '../../api/client';
import { IconClipboard } from '../../components/icons';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import EmptyState from '../../components/ui/EmptyState';
import Panel from '../../components/ui/Panel';
import Table, { TableCell, TableHeaderCell } from '../../components/ui/Table';
import { notify } from '../../components/ui/toast';
import { formatLocator } from '../../lib/locator';

interface Proposal {
  entity: CanonicalEntity;
  alias: HarvestedAlias;
}

function ProposalRow({
  proposal,
  onDecided,
  onConfirmError,
}: {
  proposal: Proposal;
  onDecided: (updated: CanonicalEntity) => void;
  onConfirmError: (message: string) => void;
}) {
  const { entity, alias } = proposal;
  const [confirming, setConfirming] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);

  // Confirming only moves the alias into `entity.aliases`, which the entity editor can still
  // remove — reversible enough that a plain button, not a confirmation dialog, is the right
  // weight.
  async function handleConfirm() {
    setConfirming(true);
    try {
      const updated = await applyHarvestedAlias(entity.id, alias.alias);
      notify('success', `Confirmed "${alias.alias}" as an alias of "${entity.canonicalName}".`);
      onDecided(updated);
    } catch (err: unknown) {
      onConfirmError(err instanceof Error ? err.message : 'Failed to record the decision');
    } finally {
      setConfirming(false);
    }
  }

  async function handleReject() {
    setRejecting(true);
    setRejectError(null);
    try {
      const updated = await revokeHarvestedAlias(entity.id, alias.alias);
      notify('success', `Rejected "${alias.alias}" for "${entity.canonicalName}".`);
      setRejectOpen(false);
      onDecided(updated);
    } catch (err: unknown) {
      setRejectError(err instanceof Error ? err.message : 'Failed to record the decision');
    } finally {
      setRejecting(false);
    }
  }

  return (
    <tr>
      <TableCell label="Canonical name">{entity.canonicalName}</TableCell>
      <TableCell label="Proposed alias">{alias.alias}</TableCell>
      {/* The locator and quote are this proposal's evidence; once the document workbench route
          exists, this is where its link belongs, built from `alias.documentVersionId` and
          `alias.locator` to open straight to the passage. */}
      <TableCell label="Evidence" className="cell-sub">
        <span className="trace-chip mono">{formatLocator(alias.locator)}</span>
        <blockquote className="proposal-evidence-quote" title={alias.quote}>
          &ldquo;{alias.quote}&rdquo;
        </blockquote>
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        {/* Confirm is the row's one signal and reversible — a plain small primary. Reject opens a
            destructive confirmation and reads as the quieter of the two, a small ghost, rather
            than matching Confirm's weight. */}
        <Button
          variant="primary"
          size="sm"
          disabled={confirming || rejecting}
          onClick={() => void handleConfirm()}
        >
          {confirming ? 'Confirming…' : 'Confirm'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={confirming || rejecting}
          onClick={() => setRejectOpen(true)}
        >
          Reject
        </Button>
        <ConfirmDialog
          open={rejectOpen}
          onClose={() => setRejectOpen(false)}
          title={`Reject "${alias.alias}"?`}
          body={`Rejecting marks this proposed alias of "${entity.canonicalName}" as revoked. It will not be re-proposed from the same evidence and cannot be undone.`}
          confirmLabel="Reject alias"
          destructive
          busy={rejecting}
          error={rejectError ?? undefined}
          onConfirm={() => void handleReject()}
        />
      </TableCell>
    </tr>
  );
}

interface ProposalsQueueProps {
  entities: CanonicalEntity[];
  onEntityChanged: (updated: CanonicalEntity) => void;
  // Re-fetches the entity list after a scan writes new proposals server-side — the scan response
  // itself carries only a count, not the rows it touched.
  onScanned: () => Promise<void>;
}

/**
 * The review queue this page exists for: every `proposed` harvested alias across the entities
 * currently loaded, document-read or near-match alike. The two sources share one shape and one
 * confirm/reject action, so this component never needs to know which kind proposed a given row —
 * "evidence applies, inference proposes" is enforced server-side, by what can reach `proposed` in
 * the first place, not by anything this queue distinguishes on render.
 */
export default function ProposalsQueue({
  entities,
  onEntityChanged,
  onScanned,
}: ProposalsQueueProps) {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // One surface for every confirm failure across the queue, rather than an error string living
  // inside the row that failed — `handleDecided` clears it so a stale failure never outlives the
  // decision that superseded it. Reject failures render through `ConfirmDialog`'s own `error`
  // prop instead, the same convention every other destructive row action in this app uses.
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const proposals = useMemo<Proposal[]>(
    () =>
      entities.flatMap((entity) =>
        entity.harvestedAliases
          .filter((alias) => alias.status === 'proposed')
          .map((alias) => ({ entity, alias })),
      ),
    [entities],
  );

  function handleDecided(updated: CanonicalEntity) {
    setConfirmError(null);
    onEntityChanged(updated);
  }

  async function handleScan() {
    setScanning(true);
    setScanError(null);
    try {
      const { proposed } = await scanNearMatches();
      notify(
        'success',
        proposed > 0
          ? `Proposed ${proposed} near-match ${proposed === 1 ? 'alias' : 'aliases'} for review.`
          : 'No new near matches found.',
      );
      await onScanned();
    } catch (err: unknown) {
      setScanError(err instanceof Error ? err.message : 'Failed to scan for near matches');
    } finally {
      setScanning(false);
    }
  }

  const scanButton = (
    <Button variant="secondary" disabled={scanning} onClick={() => void handleScan()}>
      {scanning ? 'Scanning…' : 'Scan for near matches'}
    </Button>
  );

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Proposed aliases</h2>
          {proposals.length > 0 && (
            <div className="queue-head-actions">
              {/* Counts only the entities this page loaded — the queue has no server-side filter
                  of its own, so it never claims to be a tenant-wide total. */}
              <span className="mono cell-sub">
                {proposals.length} proposal{proposals.length === 1 ? '' : 's'} on this page
              </span>
              {scanButton}
            </div>
          )}
        </div>
        <p className="page-sub">
          Suffix-only and punctuation-only spelling variants, and aliases read out of documents,
          proposed for confirmation. Nothing here resolves until you confirm it.
        </p>

        {scanError && (
          <p className="error" role="alert">
            {scanError}
          </p>
        )}
        {confirmError && (
          <p className="error" role="alert">
            {confirmError}
          </p>
        )}

        {proposals.length === 0 && (
          <EmptyState
            className="empty-state--inline"
            icon={<IconClipboard size={24} />}
            title="No proposals to review"
            description="Scan for near matches to find suffix-only or punctuation-only spelling variants worth confirming, or wait for the next document that defines one."
            action={scanButton}
          />
        )}
      </section>

      {proposals.length > 0 && (
        <Panel aria-label="Proposed aliases awaiting confirmation">
          <Table caption="Proposed aliases awaiting confirmation.">
            <thead>
              <tr>
                <TableHeaderCell>Canonical name</TableHeaderCell>
                <TableHeaderCell>Proposed alias</TableHeaderCell>
                <TableHeaderCell>Evidence</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {proposals.map((proposal) => (
                <ProposalRow
                  key={`${proposal.entity.id}::${proposal.alias.alias}`}
                  proposal={proposal}
                  onDecided={handleDecided}
                  onConfirmError={setConfirmError}
                />
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
    </>
  );
}
