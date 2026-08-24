import { useParams } from 'react-router-dom';
import MetricPackDetail from './metric-packs/MetricPackDetail';
import MetricPackList from './metric-packs/MetricPackList';

/** Route switch on `useParams()`, mirroring DataRoomPage: the list view with no params, the
 * detail view for one packId/version pair. `listMetricPacks` has no single-version fetch, so the
 * detail view reads from the same tenant-wide list rather than a dedicated GET. */
export default function MetricPacksPage() {
  const { packId, version } = useParams<{ packId: string; version: string }>();
  return packId && version ? (
    <MetricPackDetail packId={packId} version={Number(version)} />
  ) : (
    <MetricPackList />
  );
}
