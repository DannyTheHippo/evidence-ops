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
   *  here; a reader with no action to offer (the answer apparatus) omits it. Which value, if any,
   *  gets a primary-styled action is the caller's call — this component states the recommendation,
   *  it does not decide what a caller does about it. */
  renderAction?: (value: ConflictValue) => ReactNode;
}

/**
 * Side-by-side comparison of a conflict's competing values. A `.policy-strip` states the policy
 * outcome once, above the grid — the rule that fired plus its explanation, or the
 * no-recommendation sentence when `ruleFired` is `'none'` — so the recommendation reads as a fact
 * about the conflict rather than something buried inside one card. `ruleFired === undefined` (an
 * unscorable conflict, where no survivorship policy ran at all) renders no strip.
 *
 * Each value is its own card in a responsive grid, leading with its value and unit as a mono
 * tabular figure, then its source passage and trace chip. The value matching
 * `proposedWinnerFactId` additionally carries a "Recommended · rule" band and signal-tinted
 * treatment. A withdrawn value dims through `--ink-dim` and a badge rather than `opacity`, which
 * would composite its text under the AA contrast floor along with everything else in the card.
 */
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
      {ruleFired && (
        <div className="policy-strip">
          {ruleFired === 'none' ? (
            <span>Policy has no recommendation for this conflict — {explanation}</span>
          ) : (
            <>
              <span className="policy-strip-label">Recommended · {ruleFired}</span>
              {explanation && <span className="policy-strip-reason">{explanation}</span>}
            </>
          )}
        </div>
      )}

      <ul className="value-compare" aria-label="Competing values for this conflict">
        {values.map((value) => {
          const resolved = documentIndex.get(value.documentVersionId);
          const title = resolved?.documentTitle ?? 'Unknown document';
          const isRecommended =
            !!ruleFired && ruleFired !== 'none' && value.factId === proposedWinnerFactId;
          const itemClassName = [
            'value-compare-item',
            isRecommended ? 'value-compare-item--recommended' : null,
            value.withdrawn ? 'value-compare-item--withdrawn' : null,
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <li key={value.factId} className={itemClassName}>
              {isRecommended && (
                <span className="value-compare-band">Recommended · {ruleFired}</span>
              )}
              <span className="value-compare-figure mono">
                {value.value} {value.unit}
              </span>
              <span className="cell-sub">
                {title} — {formatLocator(value.locator)}
              </span>
              <ValueTraceChip value={value} resolved={resolved} />
              {value.withdrawn && <Badge tone="caution">Source withdrawn</Badge>}
              {renderAction && <div className="value-compare-action">{renderAction(value)}</div>}
            </li>
          );
        })}
      </ul>
    </>
  );
}
