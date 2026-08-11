import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { ApprovalState } from '../../../../../database/schemas/workflow/approval/approval.schema';
import { APPROVAL_STATES } from '../../../../../database/schemas/workflow/approval/approval.schema';

/** Plain shape, not a nested response-DTO class with its own `@Expose()`s: `ApprovalsService`
 *  builds this object field-for-field from `Approval.subject` (never spreads it) — see
 *  `toConflictDto`'s identical reasoning for `factKey` in `conflicts.service.ts` — because the
 *  schema's inline `{ type: {...} }` subject shorthand has no `_id: false` and would otherwise mint
 *  a stray subdocument `_id` into the response. */
export interface ApprovalSubjectShape {
  entityType: string;
  entityId: string;
}

export class ApprovalResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Approval identifier.' })
  id: string;

  @Expose()
  @ApiProperty({
    example: { entityType: 'Conflict', entityId: '65f1c2e4a1b2c3d4e5f6a7b9' },
    description: 'The entity this approval gates.',
  })
  subject: ApprovalSubjectShape;

  @Expose()
  @ApiProperty({ example: 'resolve_conflict', description: 'The action being approved.' })
  action: string;

  @Expose()
  @ApiProperty({
    example: 'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
    description: 'Human-readable summary of the requested action.',
  })
  summary: string;

  @Expose()
  @ApiProperty({
    example: 'reviewer@example.com',
    description: 'Who or what requested the approval.',
    required: false,
  })
  requestedBy?: string;

  @Expose()
  @ApiProperty({ example: 'pending', enum: APPROVAL_STATES, description: 'Approval state.' })
  state: ApprovalState;

  @Expose()
  @ApiProperty({
    example: 'reviewer@example.com',
    description: 'Who decided the approval.',
    required: false,
  })
  decidedBy?: string;

  @Expose()
  @ApiProperty({
    example: '2026-07-02T00:00:00.000Z',
    description: 'When the decision was made.',
    required: false,
  })
  decidedAt?: Date;

  @Expose()
  @ApiProperty({
    example: 'Evidence checks out.',
    description: 'Optional rationale for the decision.',
    required: false,
  })
  decisionReason?: string;

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Approval creation timestamp.' })
  createdAt: Date;
}
