import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { BadgeTone } from './Badge';

interface StatProps {
  label: string;
  value: ReactNode;
  tone?: BadgeTone;
  hint?: string;
  /** Turns the figure into a link to its own detail view. */
  to?: string;
  /** Selects the value's register: 'numeric' (the default) keeps the large mono tabular figure;
   * 'text' renders a prose value at the body register, for a stat whose value is a phrase. */
  kind?: 'numeric' | 'text';
}

/** One dashboard or detail-page figure: a micro-label, a value, and an optional hint, laid out for
 * `.stat-row`. `kind` selects the value's register — the default `'numeric'` keeps the large mono
 * tabular figure, `'text'` renders a prose value at the body register. `tone` reuses `Badge`'s
 * semantic vocabulary so a stat reads consistently with the badges beside it; `neutral` (the
 * default) leaves the value in the page's ordinary ink rather than tinting it. Supplying `to`
 * renders the whole figure as a link to its own detail view instead of a plain `<div>`. */
export default function Stat({
  label,
  value,
  tone = 'neutral',
  hint,
  to,
  kind = 'numeric',
}: StatProps) {
  const valueClass = [
    'stat-row-value',
    kind === 'numeric' ? 'mono' : 'stat-row-value--text',
    tone !== 'neutral' ? `stat-row-value--${tone}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      <span className="stat-row-label">{label}</span>
      <span className={valueClass}>{value}</span>
      {hint && <span className="stat-row-hint">{hint}</span>}
    </>
  );

  if (to) {
    return (
      <Link to={to} className="stat-row-item">
        {content}
      </Link>
    );
  }

  return <div className="stat-row-item">{content}</div>;
}
