import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import {
  APPROVAL_STATES,
  type ApprovalState,
} from '../../../../../database/schemas/workflow/approval/approval.schema';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export const APPROVAL_SORT_FIELDS = ['createdAt', 'state', 'decidedAt'] as const;
export type ApprovalSortField = (typeof APPROVAL_SORT_FIELDS)[number];

export const DEFAULT_APPROVAL_SORT_FIELD: ApprovalSortField = 'createdAt';
export const DEFAULT_APPROVAL_SORT_DIRECTION: SortDirection = 'desc';

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

  @ApiProperty({
    example: 'a3f1b2c4-5678-4d9e-9abc-1234567890ab',
    description:
      "Narrows the inbox to approvals requested by one workflow. Omit it for the tenant's whole " +
      'inbox.',
    required: false,
  })
  @IsOptional()
  @IsString()
  workflowId?: string;

  @ApiProperty({
    example: 'createdAt',
    enum: APPROVAL_SORT_FIELDS,
    description: 'Field to sort by. Defaults to createdAt.',
    required: false,
  })
  @IsOptional()
  @IsIn(APPROVAL_SORT_FIELDS)
  sort?: ApprovalSortField;

  @ApiProperty({
    example: 'desc',
    enum: SORT_DIRECTIONS,
    description: 'Sort direction. Defaults to desc.',
    required: false,
  })
  @IsOptional()
  @IsIn(SORT_DIRECTIONS)
  sortDir?: SortDirection;
}
