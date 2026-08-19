import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsOptional, IsString } from 'class-validator';
import {
  AUDIT_EVENT_ORIGINS,
  type AuditEventOrigin,
} from '../../../../../database/schemas/audit/audit-event/audit-event.schema';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

// actorId is deliberately not a filter here — deferred until a consumer needs it (see the
// feature's plan note); adding it later is additive, not a breaking change to this DTO.
export class ListAuditEventsRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'approvals.decided',
    description: 'Exact audit action to filter by.',
    required: false,
  })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiProperty({
    example: 'Approval',
    description: 'Exact subject entity type to filter by.',
    required: false,
  })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b8',
    description: 'Exact subject entity id to filter by.',
    required: false,
  })
  @IsOptional()
  @IsMongoId()
  entityId?: string;

  @ApiProperty({
    example: 'mcp',
    enum: AUDIT_EVENT_ORIGINS,
    description:
      "Exact origin to filter by: 'mcp' for an AI client holding a PAT, 'api' otherwise.",
    required: false,
  })
  @IsOptional()
  @IsIn(AUDIT_EVENT_ORIGINS)
  origin?: AuditEventOrigin;

  @ApiProperty({
    example: 'authz-denied',
    description: 'Exact refusal reason to filter by, matching mcp.tool_call.refused rows.',
    required: false,
  })
  @IsOptional()
  @IsString()
  refusalReason?: string;
}
