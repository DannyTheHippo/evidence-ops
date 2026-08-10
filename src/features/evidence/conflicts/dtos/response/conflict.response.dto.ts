import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { ConflictStatus } from '../../../../../database/schemas/evidence/conflict/conflict.schema';
import { CONFLICT_STATUSES } from '../../../../../database/schemas/evidence/conflict/conflict.schema';
import type { FactKey } from '../../../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';

export class ConflictResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Conflict identifier.' })
  id: string;

  @Expose()
  @ApiProperty({
    example: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
    description: 'The fact key every disagreeing ExtractedFact in this conflict shares.',
  })
  factKey: FactKey;

  @Expose()
  @ApiProperty({
    type: [String],
    description: 'Identifiers of the two or more disagreeing ExtractedFact documents.',
  })
  factIds: string[];

  @Expose()
  @ApiProperty({
    example: 0.0085,
    description: "Normalized disagreement magnitude between the group's values.",
  })
  magnitude: number;

  @Expose()
  @ApiProperty({ example: 'open', enum: CONFLICT_STATUSES, description: 'Conflict status.' })
  status: ConflictStatus;

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Conflict creation timestamp.' })
  createdAt: Date;
}
