import { useEffect, useState } from 'react';
import { listMetricPacks, type MetricPack, type MetricPackStatus } from '../../api/client';
import { IconLayers } from '../../components/icons';
import Badge, { type BadgeTone } from '../../components/ui/Badge';
import EmptyState from '../../components/ui/EmptyState';
import Skeleton from '../../components/ui/Skeleton';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from '../../components/ui/Table';

// draft carries the same attention-flag register ApprovalsPage gives 'pending' and ConflictsPage
// gives 'open' — awaiting a next action, not a failure. published is a ready, informational
// midpoint before an operator commits to it. active is the one version actually governing
// extraction and detection right now. retired is explicitly not an error, the same disposition
// Badge gives a dismissed conflict.
const STATUS_TONE: Record<MetricPackStatus, BadgeTone> = {
  draft: 'caution',
  published: 'info',
  active: 'verified',
  retired: 'neutral',
};

/** The tenant's authored pack versions across every packId — `listMetricPacks` returns the whole
 * set unpaginated, so this renders straight from the response rather than a fetch page. */
export default function MetricPackList() {
  const [packs, setPacks] = useState<MetricPack[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMetricPacks()
      .then(({ docs }) => {
        setPacks(docs);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load metric packs');
      });
  }, []);

  // Newest version first within a packId, packId groups alphabetical — an operator scans for
  // "what's live right now" before "what's still a draft".
  const sorted = packs
    ? [...packs].sort((a, b) => a.packId.localeCompare(b.packId) || b.version - a.version)
    : null;

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Admin</span>
          <h1 className="page-title">Metric Packs</h1>
          <p className="page-sub">
            Every authored version of this tenant&apos;s metric ontology, from draft through
            retired.
          </p>
        </div>
      </div>

      {error && (
        <p className="error error--page" role="alert">
          {error}
        </p>
      )}

      {!sorted && !error && <Skeleton label="Loading metric packs…" />}

      {sorted && sorted.length === 0 && (
        <EmptyState
          icon={<IconLayers size={24} />}
          title="No authored pack versions yet"
          description="This tenant is still running the built-in metric ontology. A draft version is authored through the API, then reviewed, published and activated here."
        />
      )}

      {sorted && sorted.length > 0 && (
        <section className="panel">
          <Table caption="This tenant's authored metric pack versions.">
            <thead>
              <tr>
                <TableHeaderCell>Pack</TableHeaderCell>
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Label</TableHeaderCell>
                <TableHeaderCell>Metrics</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {sorted.map((pack) => {
                const to = `/metric-packs/${pack.packId}/${pack.version}`;
                return (
                  <TableRow key={pack.id} to={to}>
                    <TableCell label="Pack">
                      <RowLink to={to}>{pack.packId}</RowLink>
                    </TableCell>
                    <TableCell label="Version" className="num">
                      v{pack.version}
                    </TableCell>
                    <TableCell label="Status">
                      <Badge tone={STATUS_TONE[pack.status]}>{pack.status}</Badge>
                    </TableCell>
                    <TableCell label="Label" className="cell-sub">
                      {pack.label}
                    </TableCell>
                    <TableCell label="Metrics" className="num">
                      {pack.metrics.length}
                    </TableCell>
                    <TableCell label="Created" className="cell-sub">
                      {new Date(pack.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        </section>
      )}
    </div>
  );
}
