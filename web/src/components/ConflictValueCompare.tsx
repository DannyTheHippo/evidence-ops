import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ConflictRuleFired, ConflictValue } from '../api/client';
import { workbenchHref } from '../lib/citation-link';
import { truncateSha256 } from '../lib/identifiers';
import { formatLocator } from '../lib/locator';
import type { ResolvedVersion } from '../lib/document-index';
import Badge from './ui/Badge';

interface ValueTraceChipProps {
  value: ConflictValue;
  resolved?: ResolvedVersion;
}

// Mirrors ProvenanceRail's TraceChip: a resolved value links into the workbench at its exact
// source chunk, an unresolved one renders the same label as a plain, non-interactive `<span>`
// rather than a guessed or dead link.
function ValueTraceChip({ value, resolved }: ValueTraceChipProps) {
  const label = truncateSha256(value.sourceChunkId);
  if (resolved) {
    return (
      <Link
        to={workbenchHref({
          documentId: resolved.documentId,
          versionId: value.documentVersionId,
          chunkId: value.sourceChunkId,
        })}
        className="trace-chip mono"
        title={value.sourceChunkId}
      >
        {label}
      </Link>
    );
  }
  return (
    <span className="trace-chip mono" title={value.sourceChunkId}>
      {label}
    </span>
  );
}

interface ConflictValueCompareProps {
  values: ConflictValue[];
  proposedWinnerFactId?: string;
  ruleFired?: ConflictRuleFired;
  explanation?: string;
  documentIndex: Map<string, ResolvedVersion>;
  /** Per-value trailing slot — the conflict review queue renders a "Request resolution" button
   *  here; a reader with no action to offer (the answer apparatus) omits it. */
  renderAction?: (value: ConflictValue) => ReactNode;
}

/** Side-by-side comparison of a conflict's competing values, each showing its source passage
 *  (document title, locator, and source chunk), its own unit and magnitude, and whether it is
 *  withdrawn. The value matching `proposedWinnerFactId` additionally carries the rule that
 *  produced it and the policy's explanation; `ruleFired === 'none'` renders that explanation once,
 *  ahead of the list, in place of a per-value badge. Layout is `.value-compare`'s existing
 *  flex-wrap, not a fixed two-column grid — the shape that keeps three or more values readable
 *  instead of forcing a pair. */
export default function ConflictValueCompare({
  values,
  proposedWinnerFactId,
  ruleFired,
  explanation,
  documentIndex,
  renderAction,
}: ConflictValueCompareProps) {
  return (
    <>
      {ruleFired === 'none' && (
        <p className="cell-sub">
          <span
            className="cell-truncate"
            title={`Policy has no recommendation for this conflict — ${explanation}`}
          >
            Policy has no recommendation for this conflict — {explanation}
          </span>
        </p>
      )}

      <ul className="value-compare" aria-label="Competing values for this conflict">
        {values.map((value) => {
          const resolved = documentIndex.get(value.documentVersionId);
          const title = resolved?.documentTitle ?? 'Unknown document';
          const isRecommended = value.factId === proposedWinnerFactId;
          return (
            <li
              key={value.factId}
              className={
                isRecommended
                  ? 'value-compare-item value-compare-item--recommended'
                  : 'value-compare-item'
              }
            >
              <span className="mono">
                {value.value} {value.unit}
              </span>
              <span className="cell-sub">
                {title} — {formatLocator(value.locator)}
              </span>
              <ValueTraceChip value={value} resolved={resolved} />
              {value.withdrawn && <Badge tone="caution">Source withdrawn</Badge>}
              {isRecommended && ruleFired && ruleFired !== 'none' && (
                <>
                  <Badge tone="info">recommended · {ruleFired}</Badge>
                  {explanation && (
                    <p className="cell-sub">
                      <span className="cell-truncate" title={explanation}>
                        {explanation}
                      </span>
                    </p>
                  )}
                </>
              )}
              {renderAction?.(value)}
            </li>
          );
        })}
      </ul>
    </>
  );
}
