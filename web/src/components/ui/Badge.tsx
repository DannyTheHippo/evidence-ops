import type { ReactNode } from 'react';

interface BadgeProps {
  tone: 'verified' | 'caution' | 'rejected' | 'info' | 'neutral';
  children: ReactNode;
}

/** Maps a semantic tone to the existing `badge--*` modifier in `primitives.css`: `verified` →
 * `badge--strong` (the filled-circle marker), `caution` → `badge--possible` (triangle),
 * `rejected` → `badge--reject` (octagon), `info` → `badge--info`
 * (diamond), `neutral` → `badge--neutral` (square). */
const toneClass: Record<BadgeProps['tone'], string> = {
  verified: 'badge--strong',
  caution: 'badge--possible',
  rejected: 'badge--reject',
  info: 'badge--info',
  neutral: 'badge--neutral',
};

export default function Badge({ tone, children }: BadgeProps) {
  return <span className={`badge ${toneClass[tone]}`}>{children}</span>;
}
