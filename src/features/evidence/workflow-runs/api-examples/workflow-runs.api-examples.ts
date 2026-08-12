import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const exampleRunningRun = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  workflowId: 'a3f1b2c4-5678-4d9e-9abc-1234567890ab',
  status: 'running',
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const workflowRunsApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    description: 'Runs matching the given workflowId, most recent first.',
    examples: {
      example: {
        summary: 'One running run',
        value: { docs: [exampleRunningRun], count: 1 },
      },
    },
  },
  detail: {
    status: HttpStatus.OK,
    description: "The run's current status, best-effort refreshed from the live workflow engine.",
    examples: {
      example: {
        summary: 'Running resolveConflict run',
        value: exampleRunningRun,
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'WorkflowRun does not exist.',
    examples: {
      example: {
        summary: 'Unknown workflow run',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "WorkflowRun '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
};
