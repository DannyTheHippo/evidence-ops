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
    description:
      'Run status. On GET /workflow-runs/:id and the SSE stream, best-effort refreshed from the ' +
      'live engine (cached up to 15s, falling back to this durable value on an engine failure). ' +
      'On the list endpoint, always the durable row as last written by the workflow — the list ' +
      'never queries the engine, so a status filter there matches stored state, not live state.',
  })
  status: WorkflowRunStatus;

  @Expose()
  @ApiProperty({
    example: 'Timed out waiting for approval',
    description: 'Error detail, present only when status is failed.',
    required: false,
  })
  errorMessage?: string;

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7c0',
    description:
      'Identifier of the entity this run acted on, present when the run carries a subject ' +
      'reference. Read alongside subjectType, never alone.',
    required: false,
  })
  subjectId?: string;

  @Expose()
  @ApiProperty({
    example: 'Answer',
    description: "The subjectId's entity type, present exactly when subjectId is.",
    required: false,
  })
  subjectType?: string;

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Run creation timestamp.' })
  createdAt: Date;
}
