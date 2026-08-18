import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  APPROVAL_STATES,
  type ApprovalState,
} from '../../../../../database/schemas/workflow/approval/approval.schema';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export class ListApprovalsRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'pending',
    enum: APPROVAL_STATES,
    description:
      'Approval state to filter by. Defaults to `pending` — this endpoint is the pending inbox.',
    required: false,
  })
  @IsOptional()
  @IsIn(APPROVAL_STATES)
  state?: ApprovalState;
}
