import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { Link } from 'react-router-dom';
import {
  applyHarvestedAlias,
  revokeHarvestedAlias,
  scanNearMatches,
  type CanonicalEntity,
  type HarvestedAlias,
} from '../../api/client';
import { IconClipboard } from '../../components/icons';
import Alert from '../../components/ui/Alert';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import EmptyState from '../../components/ui/EmptyState';
import Panel from '../../components/ui/Panel';
import Table, { TableCell, TableHeaderCell } from '../../components/ui/Table';
import { notify } from '../../components/ui/toast';
import Tooltip from '../../components/ui/Tooltip';
import { workbenchHref } from '../../lib/citation-link';
import type { ResolvedVersion } from '../../lib/document-index';
import { formatLocator } from '../../lib/locator';

interface Proposal {
  entity: CanonicalEntity;
  alias: HarvestedAlias;
}

/** Identifies a row by the pair that produced it — an alias is unique within its entity, and the
 * same alias text may be proposed for more than one. Keys the rendered rows and the Confirm-button
 * registry the queue focuses through. */
function proposalKey({ entity, alias }: Proposal): string {
  return `${entity.id}::${alias.alias}`;
}

function ProposalRow({
  proposal,
  documentIndex,
  confirmRef,
  onDecided,
  onConfirmError,
}: {
  proposal: Proposal;
  documentIndex: Map<string, ResolvedVersion>;
  confirmRef: Ref<HTMLButtonElement>;
  onDecided: (updated: CanonicalEntity) => void;
  onConfirmError: (message: string) => void;
}) {
  const { entity, alias } = proposal;
  const resolved = documentIndex.get(alias.documentVersionId);
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
      <TableCell label="Evidence" className="cell-sub">
        <span className="trace-chip mono">{formatLocator(alias.locator)}</span>
        <Tooltip content={alias.quote}>
          <blockquote className="proposal-evidence-quote" tabIndex={0}>
            &ldquo;{alias.quote}&rdquo;
          </blockquote>
        </Tooltip>
        {resolved ? (
          <Link
            className="trace-chip mono"
            to={workbenchHref({
              documentId: resolved.documentId,
              versionId: alias.documentVersionId,
            })}
          >
            {resolved.documentTitle}
          </Link>
        ) : (
          <span className="trace-chip mono">{alias.documentVersionId}</span>
        )}
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        {/* Confirm is the row's one signal and reversible — a plain small primary. Reject opens a
            destructive confirmation and reads as the quieter of the two, a small ghost, rather
            than matching Confirm's weight. Both take `busy` rather than `disabled`, which would
            drop focus to <body> the moment the button holding it went inert. Reject reads busy
            while a confirm is in flight too; Confirm needs no matching guard, because the reject
            confirmation is a modal dialog and the row is inert for as long as it is open. */}
        <Button
          variant="primary"
          size="sm"
          ref={confirmRef}
          busy={confirming}
          busyLabel="Confirming…"
          aria-label={`Confirm "${alias.alias}" for "${entity.canonicalName}"`}
          onClick={() => void handleConfirm()}
        >
          Confirm
        </Button>
        <Button
          variant="ghost"
          size="sm"
          busy={confirming || rejecting}
          aria-label={`Reject "${alias.alias}" for "${entity.canonicalName}"`}
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
  documentIndex: Map<string, ResolvedVersion>;
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
  documentIndex,
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
  // The landmark a decision falls back to once the queue empties and no row is left to focus.
  const headingRef = useRef<HTMLHeadingElement>(null);
  // One entry per rendered row's Confirm button, keyed as the rows are, so a decision can hand
  // focus to whichever row takes the decided one's place after it unmounts.
  const confirmButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  // Non-null only between a decision and the render that drops its row: `key` names the row to
  // focus, null means the queue is emptying and the heading takes it. The effect below consumes
  // and clears it, so an ordinary re-render never moves focus.
  const pendingFocusRef = useRef<{ key: string | null } | null>(null);

  const proposals = useMemo<Proposal[]>(
    () =>
      entities.flatMap((entity) =>
        entity.harvestedAliases
          .filter((alias) => alias.status === 'proposed')
          .map((alias) => ({ entity, alias })),
      ),
    [entities],
  );

  function handleDecided(updated: CanonicalEntity, decidedKey: string) {
    // Read off the queue as it stands, before the decision drops the row: the one below it, or
    // the one above when the decided row was last.
    const decidedIndex = proposals.findIndex((proposal) => proposalKey(proposal) === decidedKey);
    const next = proposals[decidedIndex + 1] ?? proposals[decidedIndex - 1] ?? null;
    pendingFocusRef.current = { key: next ? proposalKey(next) : null };
    setConfirmError(null);
    onEntityChanged(updated);
  }

  // Runs once the decided row has left the queue, taking the button that had focus with it, when
  // it held focus at open. The rAF matters: `use-modal-dialog.ts`'s close cleanup finds that button
  // detached and moves focus to the page heading, from an effect not ordered against this one, so a
  // synchronous `focus()` here would race it and lose.
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    requestAnimationFrame(() => {
      const nextConfirm = pending.key ? confirmButtonsRef.current.get(pending.key) : undefined;
      (nextConfirm ?? headingRef.current)?.focus();
    });
  }, [proposals]);

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
          {/* `tabIndex={-1}` makes the heading a programmatic focus target without adding a tab
              stop — where focus lands when a decision empties the queue. */}
          <h2 className="card-title" tabIndex={-1} ref={headingRef}>
            Proposed aliases
          </h2>
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

        {scanError && <Alert tone="rejected">{scanError}</Alert>}
        {confirmError && <Alert tone="rejected">{confirmError}</Alert>}

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
              {proposals.map((proposal) => {
                const key = proposalKey(proposal);
                return (
                  <ProposalRow
                    key={key}
                    proposal={proposal}
                    documentIndex={documentIndex}
                    confirmRef={(node) => {
                      if (node) confirmButtonsRef.current.set(key, node);
                      else confirmButtonsRef.current.delete(key);
                    }}
                    onDecided={(updated) => handleDecided(updated, key)}
                    onConfirmError={setConfirmError}
                  />
                );
              })}
            </tbody>
          </Table>
        </Panel>
      )}
    </>
  );
}
