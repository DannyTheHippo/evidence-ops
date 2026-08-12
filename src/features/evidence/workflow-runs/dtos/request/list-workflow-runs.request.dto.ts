import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

// workflowId is required, not optional: an unfiltered all-runs listing is new surface this cycle
// does not need, and the SPA's only known caller always has a workflowId in hand already.
export class ListWorkflowRunsRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'a3f1b2c4-5678-4d9e-9abc-1234567890ab',
    description: 'Underlying Temporal workflow id to look runs up by.',
  })
  @IsString()
  @IsNotEmpty()
  workflowId: string;
}
