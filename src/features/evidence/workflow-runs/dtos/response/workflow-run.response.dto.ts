import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type {
  WorkflowRunStatus,
  WorkflowRunType,
} from '../../../../../database/schemas/workflow/workflow-run/workflow-run.schema';
import {
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_RUN_TYPES,
} from '../../../../../database/schemas/workflow/workflow-run/workflow-run.schema';

export class WorkflowRunResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'WorkflowRun identifier.' })
  id: string;

  @Expose()
  @ApiProperty({
    example: 'a3f1b2c4-5678-4d9e-9abc-1234567890ab',
    description: 'Underlying Temporal workflow id.',
  })
  workflowId: string;

  @Expose()
  @ApiProperty({
    example: 'resolve-conflict',
    enum: WORKFLOW_RUN_TYPES,
    description:
      'Which workflow this run projects. Absent on rows written before the field existed.',
    required: false,
  })
  workflowType?: WorkflowRunType;

  @Expose()
  @ApiProperty({
    example: 'running',
    enum: WORKFLOW_RUN_STATUSES,
    description: 'Run status — best-effort refreshed from the live engine, durable row on failure.',
  })
  status: WorkflowRunStatus;

  @Expose()
  @ApiProperty({
    example: 'awaiting_approval',
    description: 'Optional human-readable current step.',
    required: false,
  })
  currentStep?: string;

  @Expose()
  @ApiProperty({
    example: 'Timed out waiting for approval',
    description: 'Error detail, present only when status is failed.',
    required: false,
  })
  errorMessage?: string;

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Run creation timestamp.' })
  createdAt: Date;
}
