import type { ReactNode } from 'react';

/** The semantic tones a badge can carry. Exported because callers that compute a tone before
 * rendering need to name the type; declaring it locally instead hand-mirrors this union with no
 * compiler link between the copies. */
export type BadgeTone = 'verified' | 'caution' | 'rejected' | 'info' | 'neutral';

interface BadgeProps {
  tone: BadgeTone;
  children: ReactNode;
}

/** Maps a semantic tone to the existing `badge--*` modifier in `primitives.css`: `verified` →
 * `badge--strong` (the filled-circle marker), `caution` → `badge--possible` (triangle),
 * `rejected` → `badge--reject` (octagon), `info` → `badge--info`
 * (diamond), `neutral` → `badge--neutral` (square). */
const toneClass: Record<BadgeTone, string> = {
  verified: 'badge--strong',
  caution: 'badge--possible',
  rejected: 'badge--reject',
  info: 'badge--info',
  neutral: 'badge--neutral',
};

export default function Badge({ tone, children }: BadgeProps) {
  return <span className={`badge ${toneClass[tone]}`}>{children}</span>;
}
