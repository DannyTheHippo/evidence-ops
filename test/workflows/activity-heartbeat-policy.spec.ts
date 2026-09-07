import { HEARTBEATING_ACTIVITIES } from '../../src/workflows/activity-heartbeat-policy';
import {
  INGEST_HEARTBEAT_INTERVAL_MS,
  INGEST_HEARTBEAT_TIMEOUT_MS,
} from '../../src/workflows/ingest-retry-policy';

describe('HEARTBEATING_ACTIVITIES', () => {
  // The relation every entry backs, not the numbers: a heartbeat slower than its own timeout fails
  // every healthy attempt, and a timeout at or above `startToCloseMs` never fires before the
  // overall timeout does — matching `ingest-retry-policy.spec.ts`'s identical relation test for
  // `ingestDocumentVersion`'s own group.
  it.each(HEARTBEATING_ACTIVITIES)(
    "should heartbeat faster than the heartbeat timeout, which fires before $activity's startToCloseMs",
    ({ startToCloseMs }) => {
      expect(INGEST_HEARTBEAT_INTERVAL_MS).toBeLessThan(INGEST_HEARTBEAT_TIMEOUT_MS);
      expect(INGEST_HEARTBEAT_TIMEOUT_MS).toBeLessThan(startToCloseMs);
    },
  );

  it('should list each activity exactly once', () => {
    const names = HEARTBEATING_ACTIVITIES.map((entry) => entry.activity);
    expect(new Set(names).size).toBe(names.length);
  });
});
