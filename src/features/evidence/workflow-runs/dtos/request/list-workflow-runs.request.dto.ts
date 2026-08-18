import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export class ListWorkflowRunsRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'a3f1b2c4-5678-4d9e-9abc-1234567890ab',
    description:
      'Underlying Temporal workflow id to filter by. Omit it to list every run for the ' +
      "caller's tenant, most recent first.",
    required: false,
  })
  @IsOptional()
  @IsString()
  workflowId?: string;
}
