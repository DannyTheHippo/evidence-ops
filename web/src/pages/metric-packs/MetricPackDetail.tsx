import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  activateMetricPackVersion,
  listMetricPacks,
  previewMetricPackActivation,
  publishMetricPackVersion,
  type MetricDefinition,
  type MetricPack,
  type MetricPackStatus,
  type PackActivationPreview,
} from '../../api/client';
import Badge, { type BadgeTone } from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Dialog from '../../components/ui/Dialog';
import Skeleton from '../../components/ui/Skeleton';
import Table, { TableCell, TableHeaderCell } from '../../components/ui/Table';
import { notify } from '../../components/ui/toast';

// Mirrors MetricPackList's reasoning: draft/published/active/retired read as an attention flag,
// an informational midpoint, the one in-force version, and an explicitly non-error disposition.
const STATUS_TONE: Record<MetricPackStatus, BadgeTone> = {
  draft: 'caution',
  published: 'info',
  active: 'verified',
  retired: 'neutral',
};

// A metric's staleness window is only ever authored in day-scale milliseconds in practice, but
// this renders whatever value is actually stored rather than assuming that scale.
function formatStaleness(ms?: number): string {
  if (!ms) return 'No staleness check';
  const days = ms / 86_400_000;
  if (Number.isInteger(days)) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.round(ms / 3_600_000);
  return `~${hours} hour${hours === 1 ? '' : 's'}`;
}

function MetricsTable({ metrics }: { metrics: MetricDefinition[] }) {
  return (
    <Table caption="This version's metric detection configuration.">
      <thead>
        <tr>
          <TableHeaderCell>Metric</TableHeaderCell>
          <TableHeaderCell>Value type</TableHeaderCell>
          <TableHeaderCell>Canonical unit</TableHeaderCell>
          <TableHeaderCell>Tolerance</TableHeaderCell>
          <TableHeaderCell>Authority order</TableHeaderCell>
          <TableHeaderCell>Staleness</TableHeaderCell>
          <TableHeaderCell>Aliases</TableHeaderCell>
        </tr>
      </thead>
      <tbody>
        {metrics.map((metric) => (
          <tr key={metric.id}>
            <TableCell label="Metric">
              {metric.label}
              <div className="cell-sub mono">{metric.id}</div>
            </TableCell>
            <TableCell label="Value type" className="cell-sub">
              {metric.valueType}
            </TableCell>
            <TableCell label="Canonical unit" className="cell-sub">
              {metric.canonicalUnit}
            </TableCell>
            <TableCell label="Tolerance" className="cell-sub">
              {metric.toleranceKind} · {metric.tolerance}
            </TableCell>
            <TableCell label="Authority order" className="cell-sub">
              {metric.authorityOrder && metric.authorityOrder.length > 0
                ? metric.authorityOrder.join(' › ')
                : 'No order configured'}
            </TableCell>
            <TableCell label="Staleness" className="cell-sub">
              {formatStaleness(metric.stalenessWindowMs)}
            </TableCell>
            <TableCell label="Aliases" className="cell-sub">
              {metric.aliases.join(', ')}
            </TableCell>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function PreviewTable({ preview }: { preview: PackActivationPreview }) {
  if (preview.metrics.length === 0) {
    return <p className="cell-sub">No detection-relevant changes; activating starts no rescan.</p>;
  }
  return (
    <Table caption="Per-metric conflict counts activating this version would produce, computed without writing anything.">
      <thead>
        <tr>
          <TableHeaderCell>Metric</TableHeaderCell>
          <TableHeaderCell>Would create</TableHeaderCell>
          <TableHeaderCell>Would retract</TableHeaderCell>
        </tr>
      </thead>
      <tbody>
        {preview.metrics.map((row) => (
          <tr key={row.metricId}>
            <TableCell label="Metric" className="mono">
              {row.metricId}
            </TableCell>
            <TableCell label="Would create" className="num">
              {row.wouldCreate}
            </TableCell>
            <TableCell label="Would retract" className="num">
              {row.wouldRetract}
            </TableCell>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default function MetricPackDetail({ packId, version }: { packId: string; version: number }) {
  const [packs, setPacks] = useState<MetricPack[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const [activateOpen, setActivateOpen] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PackActivationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const load = useCallback(() => {
    return listMetricPacks()
      .then(({ docs }) => {
        setPacks(docs);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load metric packs');
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pack = packs?.find((p) => p.packId === packId && p.version === version) ?? null;
  const notFound = packs !== null && !pack;

  function openActivateDialog() {
    setActivateOpen(true);
    setActivateError(null);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    previewMetricPackActivation(packId, version)
      .then((result) => setPreview(result))
      .catch((err: unknown) => {
        setPreviewError(err instanceof Error ? err.message : 'Failed to load activation preview');
      })
      .finally(() => setPreviewLoading(false));
  }

  async function handlePublish() {
    setPublishing(true);
    setPublishError(null);
    try {
      await publishMetricPackVersion(packId, version);
      notify('success', `Published ${packId} v${version}.`);
      setPublishOpen(false);
      // At-most-one-active is a database invariant (metric_packs_tenantId_active_unique) that a
      // status patch to this one row cannot express — a full reload is what keeps every other
      // row's status honest too, not only this one's.
      await load();
    } catch (err: unknown) {
      setPublishError(err instanceof Error ? err.message : 'Failed to publish this version');
    } finally {
      setPublishing(false);
    }
  }

  async function handleActivate() {
    setActivating(true);
    setActivateError(null);
    try {
      await activateMetricPackVersion(packId, version);
      notify('success', `Activated ${packId} v${version}.`);
      setActivateOpen(false);
      await load();
    } catch (err: unknown) {
      setActivateError(err instanceof Error ? err.message : 'Failed to activate this version');
    } finally {
      setActivating(false);
    }
  }

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Admin</span>
          <h1 className="page-title">
            {packId} v{version}
          </h1>
        </div>
        <Link to="/metric-packs" className="btn btn--secondary btn--sm">
          Back to metric packs
        </Link>
      </div>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {notFound && <p className="notice notice--info">Metric pack version not found.</p>}

      {!pack && !error && !notFound && <Skeleton label="Loading metric pack version…" />}

      {pack && (
        <>
          <div className="section-head">
            <h2 className="card-title">{pack.label}</h2>
            <span className="card-meta card-meta--end">
              <Badge tone={STATUS_TONE[pack.status]}>{pack.status}</Badge>
            </span>
          </div>
          {pack.parentPackId && (
            <p className="cell-sub">
              Drafted from {pack.parentPackId} v{pack.parentVersion}.
            </p>
          )}

          <section className="panel">
            <MetricsTable metrics={pack.metrics} />
          </section>

          {pack.status === 'draft' && (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">Publish</h2>
              </div>
              <p className="cell-sub">
                Publishing freezes this version&apos;s arithmetic. It becomes immutable and eligible
                to activate; it does not itself change what any extraction or conflict scan reads.
              </p>
              <div className="form-actions">
                <Button variant="secondary" onClick={() => setPublishOpen(true)}>
                  Publish
                </Button>
              </div>
              <Dialog
                open={publishOpen}
                onClose={() => setPublishOpen(false)}
                title={`Publish ${packId} v${version}?`}
              >
                <p>
                  This cannot be undone. A published version is frozen — its metric arithmetic can
                  never change again, only a later version can supersede it.
                </p>
                <div className="form-actions">
                  <Button variant="ghost" onClick={() => setPublishOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={publishing}
                    onClick={() => void handlePublish()}
                  >
                    {publishing ? 'Publishing…' : 'Publish version'}
                  </Button>
                </div>
                {publishError && (
                  <p className="error" role="alert">
                    {publishError}
                  </p>
                )}
              </Dialog>
            </section>
          )}

          {pack.status === 'published' && (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">Activate</h2>
              </div>
              <p className="cell-sub">
                Activating makes this version the tenant&apos;s active pack and starts a conflict
                rescan for every metric whose detection-relevant fields changed.
              </p>
              <div className="form-actions">
                <Button variant="primary" onClick={openActivateDialog}>
                  Activate
                </Button>
              </div>
              <Dialog
                open={activateOpen}
                onClose={() => setActivateOpen(false)}
                title={`Activate ${packId} v${version}?`}
              >
                <p>
                  This cannot be undone. It replaces the tenant&apos;s active pack and starts a
                  rescan for every affected metric.
                </p>
                {previewLoading && <Skeleton label="Loading activation preview…" lines={2} />}
                {previewError && (
                  <p className="error" role="alert">
                    {previewError}
                  </p>
                )}
                {preview && <PreviewTable preview={preview} />}
                <div className="form-actions">
                  <Button variant="ghost" onClick={() => setActivateOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={activating || previewLoading || !preview}
                    onClick={() => void handleActivate()}
                  >
                    {activating ? 'Activating…' : 'Activate version'}
                  </Button>
                </div>
                {activateError && (
                  <p className="error" role="alert">
                    {activateError}
                  </p>
                )}
              </Dialog>
            </section>
          )}

          {pack.status === 'active' && (
            <p className="notice notice--ok">This is the tenant&apos;s currently active version.</p>
          )}

          {pack.status === 'retired' && (
            <p className="notice notice--info">
              This version has been retired, superseded by a later activation.
            </p>
          )}
        </>
      )}
    </div>
  );
}
