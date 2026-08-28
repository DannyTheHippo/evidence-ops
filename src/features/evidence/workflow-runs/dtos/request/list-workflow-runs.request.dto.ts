import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type {
  WorkflowRunStatus,
  WorkflowRunType,
} from '../../../../../database/schemas/workflow/workflow-run/workflow-run.schema';
import {
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_RUN_TYPES,
} from '../../../../../database/schemas/workflow/workflow-run/workflow-run.schema';
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

  @ApiProperty({
    example: 'running',
    enum: WORKFLOW_RUN_STATUSES,
    description:
      'Filter by run status. Matches the stored row only — this endpoint never queries the ' +
      'live workflow engine, so a run whose engine-side status has since moved on can still ' +
      'match its previous stored status here.',
    required: false,
  })
  @IsOptional()
  @IsIn(WORKFLOW_RUN_STATUSES)
  status?: WorkflowRunStatus;

  @ApiProperty({
    example: 'resolve-conflict',
    enum: WORKFLOW_RUN_TYPES,
    description:
      "Filter by which workflow the run projects. Includes 'rescan-conflicts', a legacy type " +
      'no current workflow writes — accepted so a tenant with an existing legacy row can still ' +
      'filter it into view, not because new rows of that type can appear.',
    required: false,
  })
  @IsOptional()
  @IsIn(WORKFLOW_RUN_TYPES)
  workflowType?: WorkflowRunType;
}
