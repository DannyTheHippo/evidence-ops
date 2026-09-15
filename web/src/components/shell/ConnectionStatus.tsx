import { useEffect, useState } from 'react';
import {
  CONNECTION_LABELS,
  CONNECTION_TONES,
  getStreamStatus,
  subscribeStreamStatus,
  unsubscribeStreamStatus,
} from '../../lib/use-event-stream';
import type { StreamState } from '../../lib/use-event-stream';

/** Reads the module-scope stream status published by whichever page currently holds an
 * `useEventStream` subscription, and shows `CONNECTION_LABELS[state]` — the vocabulary every
 * stream-backed surface shares. Renders nothing for `'idle'` — a page holding no stream must not
 * claim liveness. The wrapper stays mounted regardless of state so the `aria-live` region exists
 * before content ever lands in it; a region created at the same moment as its first content is
 * routinely missed by screen readers. */
export default function ConnectionStatus() {
  const [state, setState] = useState<StreamState>(getStreamStatus);

  useEffect(() => {
    subscribeStreamStatus(setState);
    return () => unsubscribeStreamStatus(setState);
  }, []);

  const tone = CONNECTION_TONES[state];

  if (!tone) return <div className="connection-status" aria-live="polite" />;

  const { label, detail } = CONNECTION_LABELS[state];

  return (
    <div className="connection-status" aria-live="polite">
      <span className={`connection-dot connection-dot--${tone}`} aria-hidden="true" />
      <span className="micro-label">{label}</span>
      <span className="sr-only">. {detail}</span>
    </div>
  );
}
