import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  CONFLICT_STATUSES,
  type ConflictStatus,
} from '../../../../../database/schemas/evidence/conflict/conflict.schema';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export class ListConflictsRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'open',
    enum: CONFLICT_STATUSES,
    description: 'Exact conflict status to filter by.',
    required: false,
  })
  @IsOptional()
  @IsIn(CONFLICT_STATUSES)
  status?: ConflictStatus;
}
