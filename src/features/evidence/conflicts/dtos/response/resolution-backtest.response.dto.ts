import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { ConflictResolutionOutcome } from '../../../../../database/schemas/evidence/conflict/conflict.schema';
import type { FactKey } from '../../../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';

/** One conflict's replay outcome. Plain shape, not a nested response-DTO class with its own
 *  `@Expose()`s — same reasoning `ConflictValueShape` (`conflict.response.dto.ts`) documents:
 *  `ResolutionBacktestService` builds this object field-for-field, never spreads a Mongoose
 *  document into it. */
export interface ConflictBacktestResultShape {
  conflictId: string;
  factKey: FactKey;
  verdict: 'agreed' | 'disagreed' | 'silent' | 'unscorable';
  recordedOutcome: ConflictResolutionOutcome;
  recordedWinningFactId?: string;
  replayedRuleFired?: 'authority' | 'recency' | 'none';
  replayedWinningFactId?: string;
  unscorableReason?: string;
}

export class ResolutionBacktestResponseDto {
  @Expose()
  @ApiProperty({
    description:
      'One entry per conflict that has ever had a resolution attempt in this tenant, scored ' +
      "against the tenant's CURRENT survivorship rules.",
    example: [
      {
        conflictId: '65f1c2e4a1b2c3d4e5f6a7b8',
        factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
        verdict: 'agreed',
        recordedOutcome: 'resolved',
        recordedWinningFactId: '65f1c2e4a1b2c3d4e5f6a7b9',
        replayedRuleFired: 'authority',
        replayedWinningFactId: '65f1c2e4a1b2c3d4e5f6a7b9',
      },
      {
        conflictId: '65f1c2e4a1b2c3d4e5f6a7bc',
        factKey: { entity: 'Fenwick Logistics Center', metric: 'cap_rate', period: '2025-02' },
        verdict: 'unscorable',
        recordedOutcome: 'rejected',
        unscorableReason: "Outcome 'rejected' recorded no winning fact to score against.",
      },
    ],
  })
  results: ConflictBacktestResultShape[];

  @Expose()
  @ApiProperty({
    example: 11,
    description: 'Count of conflicts where the replayed rule picked the fact the human picked.',
  })
  agreed: number;

  @Expose()
  @ApiProperty({
    example: 1,
    description: 'Count of conflicts where the replayed rule picked a different fact.',
  })
  disagreed: number;

  @Expose()
  @ApiProperty({
    example: 2,
    description: 'Count of conflicts where the replayed rule fired no opinion.',
  })
  silent: number;

  @Expose()
  @ApiProperty({
    example: 1,
    description: 'Count of conflicts that cannot be judged at all, regardless of rule content.',
  })
  unscorable: number;

  @Expose()
  @ApiProperty({
    example: 0.9166666666666666,
    description:
      'agreed / (agreed + disagreed) — silent and unscorable conflicts count toward neither ' +
      'side. null, never 0, when nothing was scorable: 0 would assert the rule always ' +
      'disagreed, a different and false claim.',
    nullable: true,
  })
  agreementRate: number | null;
}
