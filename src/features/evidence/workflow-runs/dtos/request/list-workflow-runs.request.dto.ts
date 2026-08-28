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
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export const WORKFLOW_RUN_SORT_FIELDS = ['createdAt', 'status', 'workflowType'] as const;
export type WorkflowRunSortField = (typeof WORKFLOW_RUN_SORT_FIELDS)[number];

export const DEFAULT_WORKFLOW_RUN_SORT_FIELD: WorkflowRunSortField = 'createdAt';
export const DEFAULT_WORKFLOW_RUN_SORT_DIRECTION: SortDirection = 'desc';

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

  @ApiProperty({
    example: 'createdAt',
    enum: WORKFLOW_RUN_SORT_FIELDS,
    description: 'Field to sort by. Defaults to createdAt.',
    required: false,
  })
  @IsOptional()
  @IsIn(WORKFLOW_RUN_SORT_FIELDS)
  sort?: WorkflowRunSortField;

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
