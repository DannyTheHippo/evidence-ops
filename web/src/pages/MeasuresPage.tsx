import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { listMeasures, rejectMeasure, type Measure, type MeasureStatus } from '../api/client';
import { IconClipboard } from '../components/icons';
import QueueList from '../components/QueueList';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge, { type BadgeTone } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import DescriptionList from '../components/ui/DescriptionList';
import Dialog from '../components/ui/Dialog';
import ErrorSummary from '../components/ui/ErrorSummary';
import Pager from '../components/ui/Pager';
import SegmentedControl from '../components/ui/SegmentedControl';
import SplitView from '../components/ui/SplitView';
import Textarea from '../components/ui/Textarea';
import Timestamp from '../components/ui/Timestamp';
import Tooltip from '../components/ui/Tooltip';
import { notify } from '../components/ui/toast';
import { workbenchHref } from '../lib/citation-link';
import { resolveDocumentVersions, type ResolvedVersion } from '../lib/document-index';
import { shortId } from '../lib/identifiers';
import { formatLocator } from '../lib/locator';
import { clampPageSize, clampSkip } from '../lib/paging';
import { useFormSubmit } from '../lib/use-form-submit';
import { useAbortableEffect } from '../lib/use-latest';
import { invalidatePendingCounts } from '../lib/use-pending-counts';
import { useSession } from '../lib/use-session';
import { useUrlState } from '../lib/use-url-state';
import MeasureEditorDialog from './measures/MeasureEditorDialog';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Declared at module scope, matching every other list page's `URL_DEFAULTS` — `useUrlState`
// adopts this once on mount and keeps that identity for the hook's lifetime.
const URL_DEFAULTS: Record<'status' | 'skip' | 'selected' | 'limit', string> = {
  status: 'proposed',
  skip: '0',
  selected: '',
  limit: '25',
};

const STATUS_OPTIONS: { value: MeasureStatus; label: string }[] = [
  { value: 'proposed', label: 'Proposed' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'rejected', label: 'Rejected' },
];

const STATUS_TONE: Record<MeasureStatus, BadgeTone> = {
  proposed: 'caution',
  confirmed: 'verified',
  rejected: 'rejected',
};

/**
 * The optional-reason reject form. Mounted only while its `MeasureCase` has the confirmation
 * open, so each open is a fresh instance — a `reason` typed and abandoned on one open never
 * survives into the next, the same freshness `MeasureEditorDialog` gets from its own
 * mount-while-open lifecycle.
 */
function RejectMeasureDialog({
  measure,
  onClose,
  onRejected,
}: {
  measure: Measure;
  onClose: () => void;
  onRejected: (measure: Measure) => void;
}) {
  const [reason, setReason] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function submit() {
    const updated = await rejectMeasure(measure.id, reason.trim() || undefined);
    onRejected(updated);
  }

  const {
    pending,
    formError,
    onSubmit,
    fieldProps,
    summary: { ref: summaryRef, errors: summaryErrors },
  } = useFormSubmit<'reason'>({ submit });

  const reasonField = fieldProps('reason');

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reject "${measure.label}"?`}
      initialFocusRef={cancelRef}
      size="sm"
    >
      <form onSubmit={onSubmit} className="form" noValidate>
        <ErrorSummary ref={summaryRef} errors={summaryErrors} formError={formError ?? undefined} />
        <p className="cell-sub">
          Facts extracted under this header stay stored but never enter conflict detection or ledger
          answers. This cannot be undone from the console.
        </p>
        <Textarea
          {...reasonField}
          label="Reason"
          optional
          maxLength={500}
          hint="Shown in the Rejected view."
          rows={3}
          value={reason}
          onChange={setReason}
          disabled={pending}
        />
        <div className="form-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onClose}
            ref={cancelRef}
          >
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={pending}>
            {pending ? 'Rejecting…' : 'Reject measure'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The case pane behind one measure: its definition, the header evidence that justified
 * proposing it, and — for an admin — the confirm/edit/reject actions. Confirming or editing
 * bumps the measure's version and triggers a scoped conflict rescan, which is why both actions
 * open `MeasureEditorDialog` rather than firing on click; that dialog carries the copy stating
 * the consequence and posts no toast of its own, so this pane's `handleSaved`/`handleRejected` are
 * the one place a measure decision is announced. Mounted fresh per measure by its caller's
 * `key={selectedMeasure.id}` — this pane's own `dialogMode`/`rejectOpen` state must never survive
 * a selection change onto a different measure.
 */
function MeasureCase({
  measure,
  documentIndex,
  canManage,
  sessionResolved,
  onChanged,
}: {
  measure: Measure;
  documentIndex: Map<string, ResolvedVersion>;
  canManage: boolean;
  sessionResolved: boolean;
  onChanged: (measure: Measure) => void;
}) {
  const [dialogMode, setDialogMode] = useState<'confirm' | 'edit' | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);

  function handleSaved(saved: Measure) {
    const verb = dialogMode === 'confirm' ? 'Confirmed' : 'Saved';
    if (saved.lastRescan?.status === 'failed') {
      notify(
        'error',
        `${verb} "${saved.label}", but the conflict rescan failed: ${saved.lastRescan.error ?? 'unknown error'}.`,
      );
    } else if (saved.lastRescan?.status === 'completed') {
      notify(
        'success',
        `${verb} "${saved.label}". Rescan completed in ${saved.lastRescan.durationMs}ms.`,
      );
    } else {
      notify('success', `${verb} "${saved.label}".`);
    }
    setDialogMode(null);
    onChanged(saved);
  }

  function handleRejected(updated: Measure) {
    notify('success', `Rejected "${updated.label}".`);
    setRejectOpen(false);
    onChanged(updated);
  }

  const detailItems = [
    { term: 'Slug', description: <span className="mono">{measure.slug}</span> },
    { term: 'Value type', description: measure.valueType },
    { term: 'Canonical unit', description: measure.canonicalUnit },
    {
      term: 'Aliases',
      description: measure.aliases.length > 0 ? measure.aliases.join(', ') : 'None',
    },
    { term: 'Tolerance', description: `${measure.tolerance} (${measure.toleranceKind})` },
    { term: 'Version', description: `v${measure.version}` },
    { term: 'Origin', description: measure.origin },
    ...(measure.confirmedAt
      ? [
          {
            term: 'Confirmed',
            description: (
              <>
                <Timestamp value={measure.confirmedAt} />
                {measure.confirmedBy ? (
                  <>
                    {' by '}
                    <span className="mono">{shortId(measure.confirmedBy)}</span>
                  </>
                ) : null}
              </>
            ),
          },
        ]
      : []),
    ...(measure.rejectedAt
      ? [
          {
            term: 'Rejected',
            description: (
              <>
                <Timestamp value={measure.rejectedAt} />
                {measure.rejectedBy ? (
                  <>
                    {' by '}
                    <span className="mono">{shortId(measure.rejectedBy)}</span>
                  </>
                ) : null}
              </>
            ),
          },
          ...(measure.rejectedReason
            ? [{ term: 'Reason', description: measure.rejectedReason }]
            : []),
        ]
      : []),
    ...(measure.lastRescan
      ? [
          {
            term: 'Last rescan',
            description: (
              <>
                <Badge tone={measure.lastRescan.status === 'completed' ? 'verified' : 'rejected'}>
                  {measure.lastRescan.status}
                </Badge>{' '}
                <Timestamp value={measure.lastRescan.at} />
                {measure.lastRescan.status === 'failed' && measure.lastRescan.error
                  ? ` — ${measure.lastRescan.error}`
                  : ` (${measure.lastRescan.durationMs}ms)`}
              </>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="card-title">{measure.label}</h2>
        <Badge tone={STATUS_TONE[measure.status]}>{measure.status}</Badge>
      </div>

      <DescriptionList columns={2} items={detailItems} />

      {measure.proposedFrom.length > 0 && (
        <>
          <div className="section-head">
            <h2 className="card-title">Header evidence</h2>
          </div>
          <ul className="citations">
            {measure.proposedFrom.map((entry, index) => {
              const resolved = documentIndex.get(entry.documentVersionId);
              return (
                <li key={index} className="citation">
                  <blockquote className="citation-quote">{entry.headerText}</blockquote>
                  <span className="trace-chip mono">{formatLocator(entry.locator)}</span>
                  {resolved ? (
                    <Link
                      className="trace-chip mono"
                      to={workbenchHref({
                        documentId: resolved.documentId,
                        versionId: entry.documentVersionId,
                      })}
                    >
                      {resolved.documentTitle}
                    </Link>
                  ) : (
                    <span className="trace-chip mono">{entry.documentVersionId}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="form-actions">
        {canManage && measure.status === 'proposed' && (
          <>
            <Button variant="primary" onClick={() => setDialogMode('confirm')}>
              Confirm…
            </Button>
            <Button variant="secondary" onClick={() => setRejectOpen(true)}>
              Reject
            </Button>
          </>
        )}
        {canManage && measure.status === 'confirmed' && (
          <Button variant="secondary" onClick={() => setDialogMode('edit')}>
            Edit…
          </Button>
        )}
        {sessionResolved && !canManage && measure.status === 'proposed' && (
          <p className="cell-sub">Confirming measures requires an admin.</p>
        )}
      </div>

      {rejectOpen && (
        <RejectMeasureDialog
          measure={measure}
          onClose={() => setRejectOpen(false)}
          onRejected={handleRejected}
        />
      )}

      {dialogMode && (
        <MeasureEditorDialog
          measure={measure}
          mode={dialogMode}
          onClose={() => setDialogMode(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

export default function MeasuresPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const status = urlState.status as MeasureStatus;
  const skip = clampSkip(urlState.skip);
  const selectedId = urlState.selected;
  const pageSize = clampPageSize(urlState.limit, PAGE_SIZE_OPTIONS, Number(URL_DEFAULTS.limit));

  const [measures, setMeasures] = useState<Measure[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  // One entry per status once its `limit: 1` probe resolves; a status a probe never reaches
  // (still in flight, or failed) is simply absent, and the segment renders without a count.
  const [statusCounts, setStatusCounts] = useState<Partial<Record<MeasureStatus, number>>>({});
  const [countsVersion, setCountsVersion] = useState(0);
  // Anchors the split view's secondary pane — outside the `MeasureCase` its selection keys, so a
  // decision that swaps the selection onto a different measure still has somewhere existing to
  // send focus once that measure's own instance (and whatever had focus inside it) is gone.
  const caseRegionRef = useRef<HTMLDivElement>(null);
  // Set by `handleChanged` only when a decision is about to change which measure is selected;
  // the effect below consumes and clears it, so an in-place edit (same measure stays selected)
  // never steals focus it has no reason to move.
  const pendingCaseFocusRef = useRef(false);
  const session = useSession();
  // Fails CLOSED on the still-loading probe too, not just anon/error — a member (or a session
  // that hasn't resolved yet) never sees the manage controls flash in before the check lands.
  const canManage = session.status === 'authed' && session.me.role === 'admin';
  const sessionResolved = session.status !== 'loading';

  useAbortableEffect(
    (isCurrent) => {
      listMeasures({ status, skip, limit: pageSize })
        .then(({ docs, count: total }) => {
          if (!isCurrent()) return;
          setMeasures(docs);
          setCount(total);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setError(err instanceof Error ? err.message : 'Failed to load measures');
        });
    },
    [status, skip, pageSize],
  );

  // Header evidence needs the document each proposedFrom entry points at — best-effort, bounded
  // to the measures this page already loaded.
  useAbortableEffect(
    (isCurrent) => {
      const versionIds =
        measures?.flatMap((measure) =>
          measure.proposedFrom.map((entry) => entry.documentVersionId),
        ) ?? [];
      if (versionIds.length === 0) return;

      resolveDocumentVersions(versionIds)
        .then((index) => {
          if (isCurrent()) setDocumentIndex(index);
        })
        .catch(() => {});
    },
    [measures],
  );

  // Per-status totals for the segmented control, so the operator can tell "nothing proposed"
  // from "everything is elsewhere" instead of guessing at an unlabelled empty queue. Each probe
  // fails open: a rejected `limit: 1` fetch leaves that status's count unset rather than
  // surfacing an error, since a broken count must never block the queue itself.
  useAbortableEffect(
    (isCurrent) => {
      STATUS_OPTIONS.forEach(({ value: probedStatus }) => {
        listMeasures({ status: probedStatus, limit: 1 })
          .then(({ count: total }) => {
            if (!isCurrent()) return;
            setStatusCounts((current) => ({ ...current, [probedStatus]: total }));
          })
          .catch(() => {});
      });
    },
    [countsVersion],
  );

  function handleStatusChange(next: MeasureStatus) {
    setUrlState({ status: next, skip: URL_DEFAULTS.skip, selected: URL_DEFAULTS.selected });
  }

  function handleSelect(id: string) {
    setUrlState({ selected: id });
  }

  // A confirm/edit/reject decision returns the row it decided on — patched in place
  // (CanonicalEntitiesPage.tsx's own shape) when it still belongs on this view, or dropped with
  // the count decremented once its status no longer matches the segmented filter.
  function handleChanged(updated: Measure) {
    if (updated.status === status) {
      setMeasures(
        (current) => current?.map((row) => (row.id === updated.id ? updated : row)) ?? current,
      );
    } else {
      const remaining = measures?.filter((row) => row.id !== updated.id) ?? null;
      setMeasures(remaining);
      setCount((current) => Math.max(0, current - 1));
      // The row that just left was the last one on a page past the first — step back rather
      // than strand the pager on a page that now has nothing to show.
      if (remaining && remaining.length === 0 && skip > 0) {
        setUrlState({ skip: String(Math.max(0, skip - pageSize)) });
      }
      // The selection is about to move to whichever measure now sits first — its case pane is a
      // fresh, separately-keyed instance, so the button that had focus a moment ago is gone.
      pendingCaseFocusRef.current = true;
    }
    setCountsVersion((current) => current + 1);
    invalidatePendingCounts();
  }

  const selectedMeasure =
    measures?.find((measure) => measure.id === selectedId) ?? measures?.[0] ?? null;

  // Runs once the selection above actually lands on a different (or no) measure following a
  // decision. The rAF matters: `use-modal-dialog.ts`'s own close cleanup moves focus — back to the
  // button that opened the now-unmounted dialog, when it held focus at open and is still attached,
  // to the page heading when it held focus at open and has since left with its case — from an
  // effect not ordered against this one, so a plain synchronous `focus()` here would race it and
  // lose.
  useEffect(() => {
    if (!pendingCaseFocusRef.current) return;
    pendingCaseFocusRef.current = false;
    requestAnimationFrame(() => caseRegionRef.current?.focus());
  }, [selectedMeasure?.id]);

  // Confirmed count in hand (not undefined-or-zero-because-the-probe-hasn't-landed) is what turns
  // "No proposed measures" — indistinguishable from a broken queue — into an honest statement
  // that the workspace has measures, just none awaiting review right now.
  const confirmedTotal = statusCounts.confirmed;
  const hasConfirmedMeasures = confirmedTotal !== undefined && confirmedTotal > 0;

  let recordStatus: RecordListStatus;
  if (measures === null) {
    recordStatus = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading measures…' };
  } else if (measures.length === 0 && count === 0) {
    recordStatus = {
      kind: 'empty',
      icon: <IconClipboard size={24} />,
      title:
        status === 'proposed'
          ? hasConfirmedMeasures
            ? 'No measures awaiting review'
            : 'No proposed measures'
          : `No ${status} measures`,
      description:
        status === 'proposed'
          ? hasConfirmedMeasures
            ? 'Every measure in this workspace is already confirmed. New ones are proposed as spreadsheet headers are ingested.'
            : 'New measures are proposed as spreadsheet headers are ingested.'
          : undefined,
    };
  } else {
    recordStatus = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Ledger"
      title="Measures queue"
      description="Measures the estate's documents report — proposed from spreadsheet headers, confirmed by an admin before they count."
      view={
        <SegmentedControl<MeasureStatus>
          aria-label="Measure status"
          options={STATUS_OPTIONS.map((option) => ({
            ...option,
            count: statusCounts[option.value],
          }))}
          value={status}
          onChange={handleStatusChange}
        />
      }
      toolbarEnd={
        measures && (
          <span className="mono cell-sub">
            {count} measure{count === 1 ? '' : 's'}
          </span>
        )
      }
      error={error ?? undefined}
      status={recordStatus}
      footer={
        measures && (
          <Pager
            count={count}
            skip={skip}
            pageSize={pageSize}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
            onPageSizeChange={(next) =>
              setUrlState({ limit: String(next), skip: URL_DEFAULTS.skip })
            }
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        )
      }
    >
      {measures && measures.length > 0 && (
        <SplitView
          ratio="queue"
          primaryLabel="Measures queue"
          secondaryLabel="Measure detail"
          primary={
            <QueueList
              items={measures}
              selectedId={selectedMeasure?.id ?? null}
              onSelect={handleSelect}
              ariaLabel="Measures awaiting review"
              renderItem={(measure) => {
                // The row's age slot reads whichever timestamp the row's own status carries, so
                // the default Proposed view dates its rows. A decided row missing its decision
                // timestamp falls back to `createdAt`, which every row has.
                const decidedAt =
                  measure.status === 'confirmed'
                    ? measure.confirmedAt
                    : measure.status === 'rejected'
                      ? measure.rejectedAt
                      : undefined;
                return {
                  identity: (
                    <>
                      {/* Plain text, not a heading: the row is a `<button>`, whose content model
                          admits no heading element. The tooltip recovers a label the row
                          truncates, on hover only — a span inside a button takes no focus of its
                          own — so the case pane stays the non-pointer route to the full label. */}
                      <Tooltip content={measure.label}>
                        <span className="queue-row-label cell-truncate">{measure.label}</span>
                      </Tooltip>
                      <Badge tone={STATUS_TONE[measure.status]}>{measure.status}</Badge>
                    </>
                  ),
                  quantifier: (
                    <>
                      <span className="mono">{measure.slug}</span> · {measure.valueType} ·{' '}
                      {measure.canonicalUnit} · {measure.proposedFrom.length} header
                      {measure.proposedFrom.length === 1 ? '' : 's'}
                    </>
                  ),
                  age: <Timestamp value={decidedAt ?? measure.createdAt} />,
                };
              }}
            />
          }
          secondary={
            <div ref={caseRegionRef} tabIndex={-1}>
              {selectedMeasure ? (
                <MeasureCase
                  key={selectedMeasure.id}
                  measure={selectedMeasure}
                  documentIndex={documentIndex}
                  canManage={canManage}
                  sessionResolved={sessionResolved}
                  onChanged={handleChanged}
                />
              ) : null}
            </div>
          }
        />
      )}
    </RecordListPage>
  );
}
