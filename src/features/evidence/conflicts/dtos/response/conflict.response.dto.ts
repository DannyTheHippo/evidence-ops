import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { ConflictStatus } from '../../../../../database/schemas/evidence/conflict/conflict.schema';
import { CONFLICT_STATUSES } from '../../../../../database/schemas/evidence/conflict/conflict.schema';
import type { EvidenceLocator } from '../../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { FactKey } from '../../../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { ResolveConflictProposal } from '../../resolve-conflict-policy';

/** Plain shape, not a nested response-DTO class with its own `@Expose()`s: `ConflictsService`
 *  builds this object field-for-field from each disagreeing `ExtractedFact` (never spreads it) —
 *  see `ApprovalSubjectShape`'s identical reasoning in `approval.response.dto.ts`. One entry per
 *  `ConflictResponseDto.factIds` element, in the same order, so a human choosing a winner can line
 *  up a `factId` with the value and provenance it produced. */
export interface ConflictValueShape {
  factId: string;
  value: number;
  unit: string;
  sourceChunkId: string;
  documentVersionId: string;
  locator: EvidenceLocator;
}

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
    example: [
      {
        factId: '65f1c2e4a1b2c3d4e5f6a7b9',
        value: 5.25,
        unit: 'percent',
        sourceChunkId: 'chunk-xlsx',
        documentVersionId: '65f1c2e4a1b2c3d4e5f6a7c0',
        locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
      },
      {
        factId: '65f1c2e4a1b2c3d4e5f6a7ba',
        value: 6.1,
        unit: 'percent',
        sourceChunkId: 'chunk-prose',
        documentVersionId: '65f1c2e4a1b2c3d4e5f6a7c1',
        locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
      },
    ],
    description:
      "Every disagreeing ExtractedFact's value and provenance, in the same order as factIds — " +
      'what a human weighs to choose which one wins.',
  })
  values: ConflictValueShape[];

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

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b9',
    description:
      'The ExtractedFact id the survivorship policy proposes as the winner, computed fresh on ' +
      "every read. Absent when ruleFired is 'none' — the policy has no proposal to make.",
    required: false,
  })
  proposedWinnerFactId?: string;

  @Expose()
  @ApiProperty({
    example: 'authority',
    enum: ['authority', 'recency', 'none'],
    description:
      "Which survivorship rule produced this proposal, or 'none' if the policy declined to " +
      'propose a winner. Never decides anything on its own — a human still resolves the conflict.',
  })
  ruleFired: ResolveConflictProposal['ruleFired'];

  @Expose()
  @ApiProperty({
    example:
      "Fact 65f1c2e4a1b2c3d4e5f6a7b9's source class 'crm-export' outranks 'memo' in the " +
      'configured authorityOrder.',
    description: "Human-readable justification for ruleFired/proposedWinnerFactId's value.",
  })
  explanation: string;
}
