import {
  CRE_PACK_ID,
  type MetricPackData,
} from '../../../../database/schemas/evidence/metric-pack/metric-pack.schema';
import { METRIC_ONTOLOGY } from '../metric-ontology';

/**
 * The code default metric pack. Its `metrics` are `METRIC_ONTOLOGY` itself, not a retuned copy —
 * this is what every tenant resolves to until it authors and activates a pack of its own
 * (`MetricPacksService.resolveActive`), so it must stay byte-identical to the ontology it replaces
 * as the source of truth.
 */
export const CRE_PACK_V1: MetricPackData = {
  packId: CRE_PACK_ID,
  version: 1,
  label: 'CRE Default',
  metrics: METRIC_ONTOLOGY,
};
