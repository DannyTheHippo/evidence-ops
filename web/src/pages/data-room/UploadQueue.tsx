import Badge, { type BadgeTone } from '../../components/ui/Badge';

/** The lifecycle a queued upload moves through, one file at a time: `queued` while it waits its
 * turn in the batch, `uploading` while the request is in flight, then one of the two terminal
 * states. `failed` carries the message that failed it — either this page's own client pre-check or
 * the server's own response — so the row explains itself without a caller having to look elsewhere. */
export type QueueRowState =
  | { kind: 'queued' }
  | { kind: 'uploading' }
  | { kind: 'uploaded' }
  | { kind: 'failed'; message: string };

export interface QueueRow {
  id: string;
  fileName: string;
  state: QueueRowState;
}

const STATE_TONE: Record<QueueRowState['kind'], BadgeTone> = {
  queued: 'neutral',
  uploading: 'info',
  uploaded: 'verified',
  failed: 'rejected',
};

const STATE_LABEL: Record<QueueRowState['kind'], string> = {
  queued: 'Queued',
  uploading: 'Uploading…',
  uploaded: 'Uploaded',
  failed: 'Failed',
};

interface UploadQueueProps {
  rows: QueueRow[];
}

/** The durable record of an upload batch, standing beside the form rather than replacing it with a
 * toast: a row moves `queued` → `uploading` → `uploaded` | `failed` and stays visible once it
 * reaches either terminal state, so "3 of 5 uploaded" is still readable after the batch finishes.
 * `uploading` renders as a plain label, never a percentage — `fetch` exposes no upload-progress
 * event, so a bar here would claim knowledge the client doesn't have. Row churn carries no
 * `aria-live` region of its own; the page's single status line is the whole announcement budget for
 * this view, and a per-row alert here would spend it on noise. */
export default function UploadQueue({ rows }: UploadQueueProps) {
  if (rows.length === 0) {
    return <p className="upload-queue-empty cell-sub">Files you add appear here.</p>;
  }

  return (
    <ul className="upload-queue">
      {rows.map((row) => (
        <li key={row.id} className="upload-queue-row">
          <span className="upload-queue-name">{row.fileName}</span>
          <Badge tone={STATE_TONE[row.state.kind]}>{STATE_LABEL[row.state.kind]}</Badge>
          {row.state.kind === 'failed' && (
            <p className="cell-sub upload-queue-message">{row.state.message}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
