import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { ConflictResolution } from '../../../../../database/schemas/evidence/conflict/conflict.schema';
import { LEDGER_STATES, type LedgerState } from '../../resolve-cell';

/** Plain shape, not a nested response-DTO class: `LedgerService` builds this object
 *  field-for-field from the winning fact (it never spreads a Mongoose document), so there is
 *  nothing for `@Expose()` to filter. `canonicalAmount` is absent, not zero, when the fact's unit
 *  does not convert into the measure's canonical one. */
export interface LedgerValueShape {
  amount: number;
  unit: string;
  canonicalAmount?: number;
}

/** The human decision behind an `adjudicated` cell, mirroring `ConflictResolution` field for
 *  field with ids as strings. Present only when a conflict over this cell was resolved. */
export interface LedgerDecisionShape {
  conflictId: string;
  outcome: ConflictResolution['outcome'];
  winningFactId?: string;
  decidedBy?: string;
  reason?: string;
  resolvedAt: Date;
  ruleFired?: ConflictResolution['ruleFired'];
  followedProposal?: boolean;
}

/** One `(entity, measure, period)` cell and the state the record resolves it to. `state` is
 *  computed from the facts and conflicts behind the cell, never stored. */
export class LedgerCellResponseDto {
  @Expose()
  @ApiProperty({ example: 'Northgate Business Park', description: 'Canonical entity name.' })
  entity: string;

  @Expose()
  @ApiProperty({ example: 'cap_rate', description: 'Measure slug.' })
  measure: string;

  @Expose()
  @ApiProperty({
    example: '2025-Q1',
    description: "Period key the cell covers; 'undated' when the facts carry no period.",
  })
  period: string;

  @Expose()
  @ApiProperty({
    example: 'single',
    enum: LEDGER_STATES,
    description:
      'How the record resolves this cell: one agreed value, a human-adjudicated winner, an open disagreement, or nothing known.',
  })
  state: LedgerState;

  @Expose()
  @ApiProperty({
    type: Object,
    required: false,
    description: 'The resolved value. Absent for a conflicted or unknown cell.',
  })
  value?: LedgerValueShape;

  @Expose()
  @ApiProperty({
    type: [String],
    description: 'Facts behind this cell — the disagreeing set when the cell is conflicted.',
  })
  factIds: string[];

  @Expose()
  @ApiProperty({
    required: false,
    description: 'The conflict over this cell, when one has been recorded.',
  })
  conflictId?: string;

  @Expose()
  @ApiProperty({
    type: Object,
    required: false,
    description: 'The decision record behind an adjudicated cell.',
  })
  decision?: LedgerDecisionShape;

  @Expose()
  @ApiProperty({
    required: false,
    description:
      'True when an adjudicated winner sits on a withdrawn document version. The decision still stands; the document behind it no longer does.',
  })
  winnerWithdrawn?: boolean;
}
