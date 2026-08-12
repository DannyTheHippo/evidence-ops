import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId, IsOptional, IsString } from 'class-validator';
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
}
