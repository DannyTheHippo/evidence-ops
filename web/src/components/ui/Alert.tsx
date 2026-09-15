import type { ReactNode } from 'react';
import type { BadgeTone } from './Badge';

interface AlertProps {
  /** Reuses Badge's semantic vocabulary. `role` is derived: 'alert' for 'rejected', 'status'
   * otherwise — an error interrupts, everything else waits its turn. */
  tone: BadgeTone;
  title?: string;
  /** Trailing control, typically a Retry Button. */
  action?: ReactNode;
  children: ReactNode;
}

const toneClass: Record<BadgeTone, string> = {
  verified: 'alert--verified',
  caution: 'alert--caution',
  rejected: 'alert--rejected',
  info: 'alert--info',
  neutral: 'alert--neutral',
};

/** Page- or form-level callout, never a `useFormSubmit` field error — those announce by moving
 * focus to the summary or control instead. `rejected` is the one tone that renders `role="alert"`;
 * every other tone renders `role="status"`, both implicitly `aria-live` without an explicit
 * attribute. */
export default function Alert({ tone, title, action, children }: AlertProps) {
  return (
    <div className={`alert ${toneClass[tone]}`} role={tone === 'rejected' ? 'alert' : 'status'}>
      {title && <p className="alert-title">{title}</p>}
      <div className="alert-body">{children}</div>
      {action && <div className="alert-action">{action}</div>}
    </div>
  );
}
