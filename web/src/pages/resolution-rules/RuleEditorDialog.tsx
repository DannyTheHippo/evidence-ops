import { useEffect, useRef, useState } from 'react';
import {
  upsertMetricPolicy,
  type DocumentSourceClass,
  type MetricId,
  type MetricPolicy,
} from '../../api/client';
import { IconChevronDown, IconChevronUp } from '../../components/icons';
import Button from '../../components/ui/Button';
import Dialog from '../../components/ui/Dialog';
import IconButton from '../../components/ui/IconButton';
import { notify } from '../../components/ui/toast';

// The classes an operator may rank, mirroring the server's own exclusion
// (upsert-metric-policy.request.dto.ts): 'unclassified' means no authority information was ever
// recorded, not the lowest rank, so it is never offered as a rankable option.
const RANKABLE_SOURCE_CLASSES: readonly DocumentSourceClass[] = [
  'crm-export',
  'pm-export',
  'spreadsheet',
  'memo',
  'report',
];

/** Every rankable class, seeded-order first, then whichever classes the seed left out in the
 * server's own canonical order — so an authoring session always starts from a complete,
 * reorderable list, whether the metric already has a rule or this is its first one. */
function buildInitialOrder(seed?: DocumentSourceClass[]): DocumentSourceClass[] {
  const seeded = seed ?? [];
  const rest = RANKABLE_SOURCE_CLASSES.filter((sourceClass) => !seeded.includes(sourceClass));
  return [...seeded, ...rest];
}

type MoveDirection = -1 | 1;

interface RuleEditorDialogProps {
  metric: MetricId;
  authorityOrder?: DocumentSourceClass[];
  // Carried through unedited on save — the server replaces a policy's whole row on PUT, so
  // omitting this would silently clear a staleness window this dialog never offers to edit.
  stalenessWindowMs?: number;
  onClose: () => void;
  onSaved: (policy: MetricPolicy) => void;
}

/** Reorder-only authoring surface for one metric's authority order, always open — its parent
 * mounts it only while editing, so each open is a fresh instance with fresh state and there is no
 * `open` prop to thread through. */
export default function RuleEditorDialog({
  metric,
  authorityOrder,
  stalenessWindowMs,
  onClose,
  onSaved,
}: RuleEditorDialogProps) {
  const [order, setOrder] = useState<DocumentSourceClass[]>(() =>
    buildInitialOrder(authorityOrder),
  );
  const [announcement, setAnnouncement] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const lastMovedRef = useRef<{
    sourceClass: DocumentSourceClass;
    direction: MoveDirection;
  } | null>(null);
  const buttonRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  function moveRow(index: number, direction: MoveDirection) {
    const to = index + direction;
    if (to < 0 || to >= order.length) return;

    const sourceClass = order[index];
    const next = [...order];
    [next[index], next[to]] = [next[to], next[index]];

    lastMovedRef.current = { sourceClass, direction };
    setOrder(next);
    setAnnouncement(`${sourceClass} moved to position ${to + 1} of ${next.length}.`);
  }

  // Runs after the row order re-renders, so it reads the moved row's actual (possibly now
  // disabled) button state rather than the state at the moment of the click. Targets the moved
  // class, not the row index — the index the user pressed at now belongs to a different class.
  // Falls back to the sibling button on the same row when the pressed one became disabled (moving
  // to either end), which is what keeps keyboard operation alive across a move that would
  // otherwise drop focus to <body>.
  useEffect(() => {
    const moved = lastMovedRef.current;
    if (!moved) return;
    lastMovedRef.current = null;

    const primaryKey = `${moved.sourceClass}-${moved.direction === -1 ? 'up' : 'down'}`;
    const siblingKey = `${moved.sourceClass}-${moved.direction === -1 ? 'down' : 'up'}`;
    const primary = buttonRefs.current.get(primaryKey);
    if (primary && !primary.disabled) {
      primary.focus();
    } else {
      buttonRefs.current.get(siblingKey)?.focus();
    }
  }, [order]);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await upsertMetricPolicy(metric, {
        authorityOrder: order,
        stalenessWindowMs,
      });
      notify('success', `Saved order for ${metric}.`);
      onSaved(updated);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save authority order');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`Authority order — ${metric}`}>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <ol className="actionable-list">
        {order.map((sourceClass, index) => (
          <li key={sourceClass} className="actionable-row">
            <span className="rank-index">{index + 1}</span>
            <span className="rank-name">{sourceClass}</span>
            <span className="rank-actions">
              <IconButton
                ref={(el) => {
                  buttonRefs.current.set(`${sourceClass}-up`, el);
                }}
                icon={<IconChevronUp />}
                aria-label={`Move ${sourceClass} up`}
                variant="ghost"
                size="sm"
                disabled={index === 0}
                onClick={() => moveRow(index, -1)}
              />
              <IconButton
                ref={(el) => {
                  buttonRefs.current.set(`${sourceClass}-down`, el);
                }}
                icon={<IconChevronDown />}
                aria-label={`Move ${sourceClass} down`}
                variant="ghost"
                size="sm"
                disabled={index === order.length - 1}
                onClick={() => moveRow(index, 1)}
              />
            </span>
          </li>
        ))}
      </ol>

      {saveError && (
        <p className="error" role="alert">
          {saveError}
        </p>
      )}

      <div className="form-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void handleSave()}>
          {saving ? 'Saving…' : 'Save order'}
        </Button>
      </div>
    </Dialog>
  );
}
