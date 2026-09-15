import Badge, { type BadgeTone } from '../../components/ui/Badge';
import Button from '../../components/ui/Button';

/** The lifecycle a queued upload moves through: `staged` while it waits in `FileInput`'s own
 * removable list for a click on Upload, `rejected` if the client precheck already refused it
 * (shown there too, carrying the reason), then `uploading` once the request is in flight and one
 * of the two terminal states. `failed` carries the message that failed it — either this page's own
 * client pre-check or the server's own response — so the row explains itself without a caller
 * having to look elsewhere. */
export type QueueRowState =
  | { kind: 'staged' }
  | { kind: 'rejected'; message: string }
  | { kind: 'uploading' }
  | { kind: 'uploaded' }
  | { kind: 'failed'; message: string };

export interface QueueRow {
  id: string;
  fileName: string;
  state: QueueRowState;
}

const STATE_TONE: Record<QueueRowState['kind'], BadgeTone> = {
  staged: 'neutral',
  rejected: 'rejected',
  uploading: 'info',
  uploaded: 'verified',
  failed: 'rejected',
};

const STATE_LABEL: Record<QueueRowState['kind'], string> = {
  staged: 'Staged',
  rejected: 'Rejected',
  uploading: 'Uploading…',
  uploaded: 'Uploaded',
  failed: 'Failed',
};

interface UploadQueueProps {
  rows: QueueRow[];
  onClearFinished: () => void;
}

/** The durable record of an upload batch, standing beside the form rather than replacing it with a
 * toast. A `staged` or `rejected` row lives in `FileInput`'s own list instead, so this view renders
 * only the three lifecycle kinds a submitted batch moves through — `uploading` → `uploaded` |
 * `failed` — and stays visible once a row reaches either terminal state, so "3 of 5 uploaded" is
 * still readable after the batch finishes. `uploading` renders as a plain label, never a
 * percentage — `fetch` exposes no upload-progress event, so a bar here would claim knowledge the
 * client doesn't have. Row churn carries no `aria-live` region of its own; the page's single status
 * line is the whole announcement budget for this view, and a per-row alert here would spend it on
 * noise. */
export default function UploadQueue({ rows, onClearFinished }: UploadQueueProps) {
  const batchRows = rows.filter(
    (row) =>
      row.state.kind === 'uploading' ||
      row.state.kind === 'uploaded' ||
      row.state.kind === 'failed',
  );

  if (batchRows.length === 0) {
    return <p className="upload-queue-empty cell-sub">Files you add appear here.</p>;
  }

  const hasFinished = batchRows.some(
    (row) => row.state.kind === 'uploaded' || row.state.kind === 'failed',
  );

  return (
    <>
      <ul className="upload-queue" role="list">
        {batchRows.map((row) => (
          <li key={row.id} className="upload-queue-row">
            <span className="upload-queue-name">{row.fileName}</span>
            <Badge tone={STATE_TONE[row.state.kind]}>{STATE_LABEL[row.state.kind]}</Badge>
            {row.state.kind === 'failed' && (
              <p className="cell-sub upload-queue-message">{row.state.message}</p>
            )}
          </li>
        ))}
      </ul>
      {hasFinished && (
        <div className="upload-queue-actions">
          <Button variant="ghost" size="sm" onClick={onClearFinished}>
            Clear finished
          </Button>
        </div>
      )}
    </>
  );
}
