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
import EmptyState from '../../components/ui/EmptyState';
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
}: {
  proposal: Proposal;
  onDecided: (updated: CanonicalEntity) => void;
}) {
  const [deciding, setDeciding] = useState<'confirm' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { entity, alias } = proposal;

  async function decide(action: 'confirm' | 'reject') {
    setDeciding(action);
    setError(null);
    try {
      const updated =
        action === 'confirm'
          ? await applyHarvestedAlias(entity.id, alias.alias)
          : await revokeHarvestedAlias(entity.id, alias.alias);
      notify(
        'success',
        action === 'confirm'
          ? `Confirmed "${alias.alias}" as an alias of "${entity.canonicalName}".`
          : `Rejected "${alias.alias}" for "${entity.canonicalName}".`,
      );
      onDecided(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to record the decision');
      setDeciding(null);
    }
  }

  return (
    <tr>
      <TableCell label="Canonical name">{entity.canonicalName}</TableCell>
      <TableCell label="Proposed alias">{alias.alias}</TableCell>
      <TableCell label="Evidence" className="cell-sub">
        <span className="mono">{formatLocator(alias.locator)}</span> — &ldquo;{alias.quote}&rdquo;
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={deciding !== null}
          onClick={() => void decide('confirm')}
        >
          {deciding === 'confirm' ? 'Confirming…' : 'Confirm'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={deciding !== null}
          onClick={() => void decide('reject')}
        >
          {deciding === 'reject' ? 'Rejecting…' : 'Reject'}
        </Button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
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

  const proposals = useMemo<Proposal[]>(
    () =>
      entities.flatMap((entity) =>
        entity.harvestedAliases
          .filter((alias) => alias.status === 'proposed')
          .map((alias) => ({ entity, alias })),
      ),
    [entities],
  );

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
    <section className="panel">
      <div className="card-head">
        <h2 className="card-title">Review queue</h2>
        {proposals.length > 0 && scanButton}
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

      {proposals.length === 0 && (
        <EmptyState
          className="empty-state--inline"
          icon={<IconClipboard size={24} />}
          title="No proposals to review"
          description="Scan for near matches to find suffix-only or punctuation-only spelling variants worth confirming, or wait for the next document that defines one."
          action={scanButton}
        />
      )}

      {proposals.length > 0 && (
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
                onDecided={onEntityChanged}
              />
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
