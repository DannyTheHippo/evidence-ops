import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { ApprovalResponseDto } from './approval.response.dto';

/** Nameable `{ docs, count }` envelope for the pending-approval inbox. */
export class ApprovalListResponseDto extends WithCountResponseDto<ApprovalResponseDto> {
  @Expose()
  @Type(() => ApprovalResponseDto)
  @ApiProperty({
    type: [ApprovalResponseDto],
    description: 'Pending approvals awaiting a decision.',
  })
  declare docs: ApprovalResponseDto[];
}
