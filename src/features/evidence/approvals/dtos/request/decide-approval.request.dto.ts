import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class DecideApprovalRequestDto {
  @ApiProperty({
    example: 'approved',
    enum: ['approved', 'rejected'],
    description: 'Human decision on the pending approval request.',
  })
  @IsIn(['approved', 'rejected'])
  decision: 'approved' | 'rejected';

  @ApiProperty({
    example: 'Evidence checks out; the spreadsheet figure is the current underwriting value.',
    description: 'Optional rationale for the decision.',
    required: false,
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
