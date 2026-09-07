import type {
  ConflictResolution,
  ConflictStatus,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import type { FactValue } from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import { isConflictingPair, normalizeFactValue } from '../conflicts/normalize-fact-value';
import type { MetricDefinition } from '../facts/metric-ontology';

export type LedgerState = 'single' | 'adjudicated' | 'conflicted' | 'unknown';

export const LEDGER_STATES: readonly LedgerState[] = [
  'single',
  'adjudicated',
  'conflicted',
  'unknown',
];

export interface CellFactInput {
  readonly id: string;
  readonly value: FactValue;
  readonly observedAt?: Date;
  readonly createdAt: Date;
  readonly withdrawn: boolean;
  readonly superseded: boolean;
}

export interface CellConflictInput {
  readonly id: string;
  readonly status: ConflictStatus;
  readonly factIds: string[];
  readonly resolution?: ConflictResolution;
  readonly createdAt: Date;
}

export interface CellValue {
  readonly amount: number;
  readonly unit: string;
  readonly canonicalAmount?: number;
}

/** A human resolution's fields, projected onto the cell that carries it — `conflictId` names which
 * `CellConflictInput` produced it, and the rest mirrors `ConflictResolution` field-for-field
 * (ids as strings, matching every other id this module returns). */
export interface CellDecision {
  readonly conflictId: string;
  readonly outcome: ConflictResolution['outcome'];
  readonly winningFactId?: string;
  readonly decidedBy?: string;
  readonly reason?: string;
  readonly resolvedAt: Date;
  readonly ruleFired?: ConflictResolution['ruleFired'];
  readonly followedProposal?: boolean;
}

export interface CellResolution {
  readonly state: LedgerState;
  readonly value?: CellValue;
  readonly factIds: string[];
  readonly conflictId?: string;
  readonly decision?: CellDecision;
  readonly winnerWithdrawn?: boolean;
}

interface AdjudicatedCandidate {
  readonly conflict: CellConflictInput;
  readonly resolution: ConflictResolution;
  readonly winner: CellFactInput;
}

/**
 * Resolves one `(entity, measure, period)` cell's current value from its facts and conflicts. This
 * is a read model, not a decision-maker — it computes the same `CellResolution` from the same
 * inputs every time, and it fails CLOSED toward `conflicted` and `unknown`, never toward a value
 * the sources do not agree on.
 *
 * Two consequences that follow directly from that failure direction, both load-bearing:
 * - An `open` conflict outranks a `resolved` one for the same cell — checked first, before any
 *   adjudication is considered — so a reopened disagreement is never hidden behind an older,
 *   already-answered one.
 * - Two or more active facts that disagree beyond the measure's tolerance report `conflicted` even
 *   when no `Conflict` row exists yet (the scan has not run over them): `unknown` would hide a real
 *   disagreement, which is the one failure mode this function exists to avoid.
 *
 * An adjudicated winner is returned even when its `DocumentVersion` has since been withdrawn — the
 * human decision stands regardless, flagged `winnerWithdrawn: true` rather than dropped to
 * `unknown`; a winner that is merely `superseded` (a newer version exists) is unaffected either way
 * (`winnerWithdrawn` only ever reflects `withdrawn`).
 */
export function resolveCell(
  measure: MetricDefinition,
  facts: readonly CellFactInput[],
  conflicts: readonly CellConflictInput[],
): CellResolution {
  const active = facts.filter((fact) => !fact.withdrawn && !fact.superseded);

  const openConflict = conflicts.find((conflict) => conflict.status === 'open');
  if (openConflict) {
    return { state: 'conflicted', factIds: openConflict.factIds, conflictId: openConflict.id };
  }

  let adjudicated: AdjudicatedCandidate | undefined;
  for (const conflict of conflicts) {
    const resolution = conflict.resolution;
    const winningFactId = resolution?.winningFactId;
    if (
      conflict.status !== 'resolved' ||
      !resolution ||
      resolution.outcome !== 'resolved' ||
      !winningFactId
    ) {
      continue;
    }
    const winner = facts.find((fact) => fact.id === winningFactId.toString());
    if (!winner) {
      continue;
    }
    if (
      !adjudicated ||
      resolution.resolvedAt.getTime() > adjudicated.resolution.resolvedAt.getTime()
    ) {
      adjudicated = { conflict, resolution, winner };
    }
  }

  if (adjudicated) {
    const { conflict, resolution, winner } = adjudicated;
    return {
      state: 'adjudicated',
      value: {
        amount: winner.value.amount,
        unit: winner.value.unit,
        canonicalAmount: normalizeFactValue(measure, winner.value),
      },
      factIds: conflict.factIds,
      decision: {
        conflictId: conflict.id,
        outcome: resolution.outcome,
        winningFactId: resolution.winningFactId?.toString(),
        decidedBy: resolution.decidedBy,
        reason: resolution.reason,
        resolvedAt: resolution.resolvedAt,
        ruleFired: resolution.ruleFired,
        followedProposal: resolution.followedProposal,
      },
      winnerWithdrawn: winner.withdrawn,
    };
  }

  if (active.length === 0) {
    return { state: 'unknown', factIds: [] };
  }

  const normalized = active
    .map((fact) => ({ fact, canonical: normalizeFactValue(measure, fact.value) }))
    .filter(
      (entry): entry is { fact: CellFactInput; canonical: number } =>
        entry.canonical !== undefined && Number.isFinite(entry.canonical),
    );

  if (normalized.length >= 2) {
    const canonicalValues = normalized.map((entry) => entry.canonical);
    const min = Math.min(...canonicalValues);
    const max = Math.max(...canonicalValues);
    if (isConflictingPair(measure, min, max)) {
      return { state: 'conflicted', factIds: active.map((fact) => fact.id) };
    }
  }

  const winner = active.reduce((latest, fact) => {
    if (fact.observedAt !== undefined && latest.observedAt === undefined) {
      return fact;
    }
    if (fact.observedAt === undefined && latest.observedAt !== undefined) {
      return latest;
    }
    if (fact.observedAt !== undefined && latest.observedAt !== undefined) {
      if (fact.observedAt.getTime() !== latest.observedAt.getTime()) {
        return fact.observedAt.getTime() > latest.observedAt.getTime() ? fact : latest;
      }
    }
    return fact.createdAt.getTime() > latest.createdAt.getTime() ? fact : latest;
  });

  return {
    state: 'single',
    value: {
      amount: winner.value.amount,
      unit: winner.value.unit,
      canonicalAmount: normalizeFactValue(measure, winner.value),
    },
    factIds: active.map((fact) => fact.id),
  };
}
