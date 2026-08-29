import { useEffect, useState } from 'react';
import {
  getStreamStatus,
  subscribeStreamStatus,
  unsubscribeStreamStatus,
} from '../../lib/use-event-stream';
import type { StreamState } from '../../lib/use-event-stream';

type ConnectionTone = 'live' | 'connecting' | 'stale' | 'polling';

const STATE_CONFIG: Partial<Record<StreamState, { label: string; tone: ConnectionTone }>> = {
  connecting: { label: 'Connecting', tone: 'connecting' },
  live: { label: 'Live', tone: 'live' },
  stale: { label: 'Stale', tone: 'stale' },
  fallback: { label: 'Polling', tone: 'polling' },
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
      {config && (
        <>
          <span className={`connection-dot connection-dot--${config.tone}`} aria-hidden="true" />
          <span className="micro-label">{config.label}</span>
        </>
      )}
    </div>
  );
}
