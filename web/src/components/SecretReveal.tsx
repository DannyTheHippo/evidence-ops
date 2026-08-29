import { useEffect, type ReactNode, type Ref } from 'react';
import Button from './ui/Button';
import CopyButton from './ui/CopyButton';
import Timestamp from './ui/Timestamp';

interface SecretRevealProps {
  /** The plaintext secret shown exactly once — a minted or rotated API token, or an invitation
   * link. Nothing upstream stores this anywhere the SPA can read it back. */
  secret: string;
  expiresAt: string;
  /** Caller-supplied caution copy naming the secret and why it will not be shown again. */
  notice: ReactNode;
  /** Slot beside `CopyButton` and Dismiss — People's mailto "Email invite" link, for instance. */
  extraActions?: ReactNode;
  onDismiss: () => void;
  /** Lets a caller move focus here once the secret appears, e.g. after a mint switches views. */
  ref?: Ref<HTMLElement>;
}

/** The one-time-secret panel shared by every surface that hands back a plaintext value exactly
 * once — a minted or rotated API token, a minted or resent invitation link. `Dismiss` takes a
 * single click and asks nothing first: friction here only pushes an operator to leave a live
 * secret on screen rather than clear it. The panel owns a `beforeunload` guard for as long as it
 * is mounted, so a caller only has to render it while it holds a real secret and remove it — via
 * `onDismiss` or by replacing it with nothing — once that secret is gone. `CopyButton` needs no
 * extra keying here: it already resets its own copied state whenever `secret` changes. */
export default function SecretReveal({
  secret,
  expiresAt,
  notice,
  extraActions,
  onDismiss,
  ref,
}: SecretRevealProps) {
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  return (
    <section ref={ref} tabIndex={-1} className="card secret-reveal">
      <span className="eyebrow">One-time secret</span>
      <p className="notice notice--warn">{notice}</p>
      <p className="secret-reveal-value mono">{secret}</p>
      <p className="secret-reveal-meta">
        Expires <Timestamp value={expiresAt} />
      </p>
      <div className="form-actions">
        <CopyButton text={secret} />
        {extraActions}
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
