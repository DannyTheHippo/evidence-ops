import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type {
  WorkflowRunOutcome,
  WorkflowRunStatus,
  WorkflowRunType,
} from '../../../../../database/schemas/workflow/workflow-run/workflow-run.schema';
import {
  WORKFLOW_RUN_OUTCOMES,
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
    example: 'resolved',
    enum: WORKFLOW_RUN_OUTCOMES,
    required: false,
    description:
      "The workflow's own verdict, written when it ends. Present on a resolve-conflict run; " +
      'absent on every other type and on rows written before the field existed.',
  })
  outcome?: WorkflowRunOutcome;

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
  @ApiProperty({
    example: false,
    description:
      'True when this response refreshed from the live engine and the engine reported the ' +
      'workflow unknown to it while the stored row was still non-terminal — the signal for a run ' +
      'orphaned by a workflow that ended through a path that never recorded its end, whose ' +
      'Temporal history has since fallen out of retention. status stays the durable row value in ' +
      'that case, unwritten. False for a terminal row, a live engine answer, or an engine call ' +
      'failure (falls back to the durable status). Present only on a response built from a read ' +
      'that asked the engine for live status; absent everywhere else means status freshness was ' +
      'never checked, not that it is known fresh.',
    required: false,
  })
  stale?: boolean;

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Run creation timestamp.' })
  createdAt: Date;
}
