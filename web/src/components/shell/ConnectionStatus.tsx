import { useEffect, useState } from 'react';
import {
  getStreamStatus,
  subscribeStreamStatus,
  unsubscribeStreamStatus,
} from '../../lib/use-event-stream';
import type { StreamState } from '../../lib/use-event-stream';
import Badge from '../ui/Badge';

const STATE_CONFIG: Partial<
  Record<StreamState, { label: string; tone: 'info' | 'verified' | 'caution' | 'neutral' }>
> = {
  connecting: { label: 'Connecting', tone: 'info' },
  live: { label: 'Live', tone: 'verified' },
  stale: { label: 'Stale', tone: 'caution' },
  fallback: { label: 'Polling', tone: 'neutral' },
};

/** Reads the module-scope stream status published by whichever page currently holds an
 * `useEventStream` subscription. Renders nothing for `'idle'` — a page holding no stream must not
 * claim liveness. The wrapper stays mounted regardless of state so the `aria-live` region exists
 * before content ever lands in it; a region created at the same moment as its first content is
 * routinely missed by screen readers. */
export default function ConnectionStatus() {
  const [state, setState] = useState<StreamState>(getStreamStatus);

  useEffect(() => {
    subscribeStreamStatus(setState);
    return () => unsubscribeStreamStatus(setState);
  }, []);

  const config = STATE_CONFIG[state];

  return (
    <div className="connection-status" aria-live="polite">
      {config && <Badge tone={config.tone}>{config.label}</Badge>}
    </div>
  );
}
