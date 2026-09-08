import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listMeasures, rejectMeasure, type Measure, type MeasureStatus } from '../api/client';
import { IconClipboard } from '../components/icons';
import QueueList from '../components/QueueList';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge, { type BadgeTone } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import DescriptionList from '../components/ui/DescriptionList';
import Pager from '../components/ui/Pager';
import SegmentedControl from '../components/ui/SegmentedControl';
import SplitView from '../components/ui/SplitView';
import Timestamp from '../components/ui/Timestamp';
import { notify } from '../components/ui/toast';
import { workbenchHref } from '../lib/citation-link';
import { resolveDocumentVersions, type ResolvedVersion } from '../lib/document-index';
import { formatLocator } from '../lib/locator';
import { useSession } from '../lib/use-session';
import { useUrlState } from '../lib/use-url-state';
import MeasureEditorDialog from './measures/MeasureEditorDialog';

const PAGE_SIZE = 20;

// Declared at module scope, matching every other list page's `URL_DEFAULTS` — `useUrlState`
// adopts this once on mount and keeps that identity for the hook's lifetime.
const URL_DEFAULTS: Record<'status' | 'skip' | 'selected', string> = {
  status: 'proposed',
  skip: '0',
  selected: '',
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
 * The case pane behind one measure: its definition, the header evidence that justified
 * proposing it, and — for an admin — the confirm/edit/reject actions. Confirming or editing
 * bumps the measure's version and triggers a scoped conflict rescan, which is why both actions
 * open `MeasureEditorDialog` rather than firing on click; that dialog carries the copy stating
 * the consequence and posts no toast of its own, so this pane's `handleSaved`/`handleReject` are
 * the one place a measure decision is announced.
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
  const [rejecting, setRejecting] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);

  async function handleReject() {
    setRejecting(true);
    setRejectError(null);
    try {
      const updated = await rejectMeasure(measure.id);
      notify('success', `Rejected "${measure.label}".`);
      setRejectOpen(false);
      onChanged(updated);
    } catch (err: unknown) {
      setRejectError(err instanceof Error ? err.message : 'Failed to reject measure');
    } finally {
      setRejecting(false);
    }
  }

  function handleSaved(saved: Measure) {
    notify(
      'success',
      dialogMode === 'confirm' ? `Confirmed "${saved.label}".` : `Saved "${saved.label}".`,
    );
    setDialogMode(null);
    onChanged(saved);
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
                {measure.confirmedBy ? ` by ${measure.confirmedBy}` : ''}
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
        {sessionResolved && !canManage && (
          <p className="cell-sub">Confirming measures requires an admin.</p>
        )}
      </div>

      <ConfirmDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title={`Reject "${measure.label}"?`}
        body="Facts extracted under this header stay stored but never enter conflict detection or ledger answers. This cannot be undone from the console."
        confirmLabel="Reject measure"
        destructive
        busy={rejecting}
        error={rejectError ?? undefined}
        onConfirm={() => void handleReject()}
      />

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
  const skip = Number(urlState.skip);
  const selectedId = urlState.selected;

  const [measures, setMeasures] = useState<Measure[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [documentIndex, setDocumentIndex] = useState<Map<string, ResolvedVersion>>(new Map());
  const session = useSession();
  // Fails CLOSED on the still-loading probe too, not just anon/error — a member (or a session
  // that hasn't resolved yet) never sees the manage controls flash in before the check lands.
  const canManage = session.status === 'authed' && session.me.role === 'admin';
  const sessionResolved = session.status !== 'loading';

  useEffect(() => {
    let cancelled = false;

    listMeasures({ status, skip, limit: PAGE_SIZE })
      .then(({ docs, count: total }) => {
        if (cancelled) return;
        setMeasures(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load measures');
      });

    return () => {
      cancelled = true;
    };
  }, [status, skip]);

  // Header evidence needs the document each proposedFrom entry points at — best-effort, bounded
  // to the measures this page already loaded.
  useEffect(() => {
    const versionIds =
      measures?.flatMap((measure) =>
        measure.proposedFrom.map((entry) => entry.documentVersionId),
      ) ?? [];
    if (versionIds.length === 0) return;
    let cancelled = false;

    resolveDocumentVersions(versionIds)
      .then((index) => {
        if (!cancelled) setDocumentIndex(index);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [measures]);

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
      setMeasures((current) => current?.filter((row) => row.id !== updated.id) ?? current);
      setCount((current) => Math.max(0, current - 1));
    }
  }

  const selectedMeasure =
    measures?.find((measure) => measure.id === selectedId) ?? measures?.[0] ?? null;

  let recordStatus: RecordListStatus;
  if (measures === null) {
    recordStatus = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading measures…' };
  } else if (measures.length === 0) {
    recordStatus = {
      kind: 'empty',
      icon: <IconClipboard size={24} />,
      title: status === 'proposed' ? 'No proposed measures' : `No ${status} measures`,
      description:
        status === 'proposed'
          ? 'New measures are proposed as spreadsheet headers are ingested.'
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
      filters={
        <SegmentedControl<MeasureStatus>
          aria-label="Measure status"
          options={STATUS_OPTIONS}
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
            pageSize={PAGE_SIZE}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
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
              renderItem={(measure) => ({
                identity: (
                  <>
                    <h2 className="card-title cell-truncate">{measure.label}</h2>
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
                age: measure.confirmedAt ? <Timestamp value={measure.confirmedAt} /> : '—',
              })}
            />
          }
          secondary={
            selectedMeasure ? (
              <MeasureCase
                measure={selectedMeasure}
                documentIndex={documentIndex}
                canManage={canManage}
                sessionResolved={sessionResolved}
                onChanged={handleChanged}
              />
            ) : null
          }
        />
      )}
    </RecordListPage>
  );
}
