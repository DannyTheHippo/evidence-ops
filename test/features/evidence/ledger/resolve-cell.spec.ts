import { Types } from 'mongoose';
import type { ConflictResolution } from '../../../../src/database/schemas/evidence/conflict/conflict.schema';
import {
  findMetricById,
  METRIC_ONTOLOGY,
} from '../../../../src/features/evidence/facts/metric-ontology';
import {
  LEDGER_STATES,
  resolveCell,
  type CellConflictInput,
  type CellFactInput,
  type CellResolution,
} from '../../../../src/features/evidence/ledger/resolve-cell';

const capRate = findMetricById(METRIC_ONTOLOGY, 'cap_rate');
if (!capRate) {
  throw new Error('metric-ontology.ts is missing cap_rate, which this spec depends on');
}

const D1 = new Date('2025-01-01T00:00:00.000Z');
const D2 = new Date('2025-02-01T00:00:00.000Z');

const FACT_A_ID = new Types.ObjectId().toString();
const FACT_B_ID = new Types.ObjectId().toString();

function fact(overrides: Partial<CellFactInput> = {}): CellFactInput {
  return {
    id: FACT_A_ID,
    value: { amount: 5.25, unit: 'percent' },
    observedAt: D1,
    createdAt: D1,
    withdrawn: false,
    superseded: false,
    ...overrides,
  };
}

function resolution(overrides: Partial<ConflictResolution> = {}): ConflictResolution {
  return { outcome: 'resolved', resolvedAt: D2, ...overrides };
}

function conflict(overrides: Partial<CellConflictInput> = {}): CellConflictInput {
  return {
    id: 'conflict-1',
    status: 'open',
    factIds: [FACT_A_ID, FACT_B_ID],
    createdAt: D1,
    ...overrides,
  };
}

interface Case {
  readonly name: string;
  readonly facts: readonly CellFactInput[];
  readonly conflicts: readonly CellConflictInput[];
  readonly expected: CellResolution;
}

describe('resolveCell', () => {
  const cases: Case[] = [
    {
      name: 'single fact',
      facts: [fact({ id: FACT_A_ID })],
      conflicts: [],
      expected: {
        state: 'single',
        value: { amount: 5.25, unit: 'percent', canonicalAmount: 0.0525 },
        factIds: [FACT_A_ID],
      },
    },
    {
      name: 'two agreeing facts — the one with the latest observedAt wins',
      facts: [
        fact({ id: FACT_A_ID, value: { amount: 5.25, unit: 'percent' }, observedAt: D1 }),
        fact({ id: FACT_B_ID, value: { amount: 5.26, unit: 'percent' }, observedAt: D2 }),
      ],
      conflicts: [],
      expected: {
        state: 'single',
        value: { amount: 5.26, unit: 'percent', canonicalAmount: 0.0526 },
        factIds: [FACT_A_ID, FACT_B_ID],
      },
    },
    {
      name: 'no facts at all',
      facts: [],
      conflicts: [],
      expected: { state: 'unknown', factIds: [] },
    },
    {
      name: 'only a withdrawn fact',
      facts: [fact({ id: FACT_A_ID, withdrawn: true })],
      conflicts: [],
      expected: { state: 'unknown', factIds: [] },
    },
    {
      name: 'only a superseded fact',
      facts: [fact({ id: FACT_A_ID, superseded: true })],
      conflicts: [],
      expected: { state: 'unknown', factIds: [] },
    },
    {
      name: 'an open conflict on the group',
      facts: [fact({ id: FACT_A_ID }), fact({ id: FACT_B_ID })],
      conflicts: [conflict({ id: 'conflict-1', status: 'open' })],
      expected: { state: 'conflicted', factIds: [FACT_A_ID, FACT_B_ID], conflictId: 'conflict-1' },
    },
    {
      name: 'active facts disagree past tolerance with no conflict row yet (A3)',
      facts: [
        fact({ id: FACT_A_ID, value: { amount: 5.25, unit: 'percent' } }),
        fact({ id: FACT_B_ID, value: { amount: 6.1, unit: 'percent' } }),
      ],
      conflicts: [],
      expected: { state: 'conflicted', factIds: [FACT_A_ID, FACT_B_ID] },
    },
    {
      name: 'a resolved conflict with a live winner',
      facts: [
        fact({ id: FACT_A_ID, value: { amount: 5.25, unit: 'percent' }, observedAt: D1 }),
        fact({ id: FACT_B_ID, value: { amount: 6.1, unit: 'percent' }, observedAt: D2 }),
      ],
      conflicts: [
        conflict({
          id: 'conflict-1',
          status: 'resolved',
          resolution: resolution({
            winningFactId: new Types.ObjectId(FACT_A_ID),
            decidedBy: 'user-1',
            reason: 'authority match',
            ruleFired: 'authority',
            followedProposal: true,
          }),
        }),
      ],
      expected: {
        state: 'adjudicated',
        value: { amount: 5.25, unit: 'percent', canonicalAmount: 0.0525 },
        factIds: [FACT_A_ID, FACT_B_ID],
        decision: {
          conflictId: 'conflict-1',
          outcome: 'resolved',
          winningFactId: FACT_A_ID,
          decidedBy: 'user-1',
          reason: 'authority match',
          resolvedAt: D2,
          ruleFired: 'authority',
          followedProposal: true,
        },
        winnerWithdrawn: false,
      },
    },
    {
      name: 'a resolved conflict whose winning fact has since been withdrawn — the decision still stands',
      facts: [
        fact({ id: FACT_A_ID, value: { amount: 5.25, unit: 'percent' }, withdrawn: true }),
        fact({ id: FACT_B_ID, value: { amount: 6.1, unit: 'percent' } }),
      ],
      conflicts: [
        conflict({
          id: 'conflict-1',
          status: 'resolved',
          resolution: resolution({ winningFactId: new Types.ObjectId(FACT_A_ID) }),
        }),
      ],
      expected: {
        state: 'adjudicated',
        value: { amount: 5.25, unit: 'percent', canonicalAmount: 0.0525 },
        factIds: [FACT_A_ID, FACT_B_ID],
        decision: {
          conflictId: 'conflict-1',
          outcome: 'resolved',
          winningFactId: FACT_A_ID,
          resolvedAt: D2,
        },
        winnerWithdrawn: true,
      },
    },
    {
      name: 'a resolved conflict whose winning fact is merely superseded — the decision still stands, unaffected',
      facts: [
        fact({ id: FACT_A_ID, value: { amount: 5.25, unit: 'percent' }, superseded: true }),
        fact({ id: FACT_B_ID, value: { amount: 6.1, unit: 'percent' } }),
      ],
      conflicts: [
        conflict({
          id: 'conflict-1',
          status: 'resolved',
          resolution: resolution({ winningFactId: new Types.ObjectId(FACT_A_ID) }),
        }),
      ],
      expected: {
        state: 'adjudicated',
        value: { amount: 5.25, unit: 'percent', canonicalAmount: 0.0525 },
        factIds: [FACT_A_ID, FACT_B_ID],
        decision: {
          conflictId: 'conflict-1',
          outcome: 'resolved',
          winningFactId: FACT_A_ID,
          resolvedAt: D2,
        },
        winnerWithdrawn: false,
      },
    },
    {
      name: 'a resolved conflict whose winning fact id names no fact in the group falls through to the active facts',
      facts: [fact({ id: FACT_A_ID })],
      conflicts: [
        conflict({
          id: 'conflict-1',
          status: 'resolved',
          factIds: [FACT_A_ID, FACT_B_ID],
          resolution: resolution({ winningFactId: new Types.ObjectId() }),
        }),
      ],
      expected: {
        state: 'single',
        value: { amount: 5.25, unit: 'percent', canonicalAmount: 0.0525 },
        factIds: [FACT_A_ID],
      },
    },
    {
      name: 'a rejected resolution attempt is not treated as an adjudication',
      facts: [fact({ id: FACT_A_ID })],
      conflicts: [
        conflict({
          id: 'conflict-1',
          status: 'resolved',
          factIds: [FACT_A_ID],
          resolution: resolution({ outcome: 'rejected', winningFactId: undefined }),
        }),
      ],
      expected: {
        state: 'single',
        value: { amount: 5.25, unit: 'percent', canonicalAmount: 0.0525 },
        factIds: [FACT_A_ID],
      },
    },
    {
      name: 'a timed-out resolution attempt is not treated as an adjudication',
      facts: [fact({ id: FACT_A_ID })],
      conflicts: [
        conflict({
          id: 'conflict-1',
          status: 'resolved',
          factIds: [FACT_A_ID],
          resolution: resolution({ outcome: 'timed_out', winningFactId: undefined }),
        }),
      ],
      expected: {
        state: 'single',
        value: { amount: 5.25, unit: 'percent', canonicalAmount: 0.0525 },
        factIds: [FACT_A_ID],
      },
    },
    {
      name: 'a machine-retracted dismissal is not treated as an adjudication',
      facts: [fact({ id: FACT_A_ID })],
      conflicts: [
        conflict({
          id: 'conflict-1',
          status: 'dismissed',
          factIds: [FACT_A_ID],
          resolution: resolution({ outcome: 'retracted', winningFactId: undefined }),
        }),
      ],
      expected: {
        state: 'single',
        value: { amount: 5.25, unit: 'percent', canonicalAmount: 0.0525 },
        factIds: [FACT_A_ID],
      },
    },
    {
      name: 'a fact with a unit the metric does not convert is skipped from the tolerance comparison',
      facts: [
        fact({ id: FACT_A_ID, value: { amount: 1, unit: 'usd' }, observedAt: D1 }),
        fact({ id: FACT_B_ID, value: { amount: 5.25, unit: 'percent' }, observedAt: D2 }),
      ],
      conflicts: [],
      expected: {
        state: 'single',
        value: { amount: 5.25, unit: 'percent', canonicalAmount: 0.0525 },
        factIds: [FACT_A_ID, FACT_B_ID],
      },
    },
    {
      name: 'an open conflict outranks an already-resolved one on the same group',
      facts: [fact({ id: FACT_A_ID }), fact({ id: FACT_B_ID })],
      conflicts: [
        conflict({ id: 'open-conflict', status: 'open' }),
        conflict({
          id: 'resolved-conflict',
          status: 'resolved',
          resolution: resolution({ winningFactId: new Types.ObjectId(FACT_A_ID) }),
        }),
      ],
      expected: {
        state: 'conflicted',
        factIds: [FACT_A_ID, FACT_B_ID],
        conflictId: 'open-conflict',
      },
    },
  ];

  it.each(cases)('should resolve $name', ({ facts, conflicts, expected }) => {
    expect(resolveCell(capRate, facts, conflicts)).toEqual(expected);
  });

  it('should pick the resolved conflict with the latest resolution when several qualify as adjudicated', () => {
    const facts = [
      fact({ id: FACT_A_ID, value: { amount: 5.25, unit: 'percent' } }),
      fact({ id: FACT_B_ID, value: { amount: 6.1, unit: 'percent' } }),
    ];
    const conflicts = [
      conflict({
        id: 'older',
        status: 'resolved',
        resolution: resolution({ winningFactId: new Types.ObjectId(FACT_B_ID), resolvedAt: D1 }),
      }),
      conflict({
        id: 'newer',
        status: 'resolved',
        resolution: resolution({ winningFactId: new Types.ObjectId(FACT_A_ID), resolvedAt: D2 }),
      }),
    ];

    const result = resolveCell(capRate, facts, conflicts);

    expect(result.state).toBe('adjudicated');
    expect(result.decision?.conflictId).toBe('newer');
  });
});

describe('LEDGER_STATES', () => {
  it('should list exactly the four states LedgerState allows', () => {
    expect(LEDGER_STATES).toEqual(['single', 'adjudicated', 'conflicted', 'unknown']);
  });
});
