import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const exampleSource = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  name: 'Deal Room Inbox',
  kind: 'local-folder',
  path: 'deal-room',
  enabled: true,
  intervalMs: 60000,
  lastSyncAt: '2026-07-01T00:00:00.000Z',
  lastSyncStatus: 'ok',
  fileCount: 42,
  createdAt: '2026-07-01T00:00:00.000Z',
};

const exampleWorkflowRun = {
  id: '65f1c2e4a1b2c3d4e5f6a7c9',
  workflowId: 'a3f1b2c4-5678-4d9e-9abc-1234567890ab',
  status: 'running',
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const sourcesApiExamples: Record<string, ApiResponseOptions> = {
  created: {
    status: HttpStatus.CREATED,
    description: 'The newly created source.',
    examples: {
      example: {
        summary: 'Created source',
        value: exampleSource,
      },
    },
  },
  list: {
    status: HttpStatus.OK,
    description: 'Paginated sources for the tenant.',
    examples: {
      example: {
        summary: 'One source',
        value: { docs: [exampleSource], count: 1 },
      },
    },
  },
  found: {
    status: HttpStatus.OK,
    description: 'The requested source.',
    examples: {
      example: {
        summary: 'Existing source',
        value: exampleSource,
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'Source does not exist for this tenant.',
    examples: {
      example: {
        summary: 'Unknown source',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Source '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
  nameConflict: {
    status: HttpStatus.CONFLICT,
    description: 'A source with this name already exists for this tenant.',
    examples: {
      example: {
        summary: 'Duplicate name',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message: "A source named 'Deal Room Inbox' already exists for this tenant",
          error: 'Conflict',
        },
      },
    },
  },
  syncAccepted: {
    status: HttpStatus.ACCEPTED,
    description:
      'The sync workflow run for this source — newly started, or the already-running one this ' +
      'request deduplicated against.',
    examples: {
      example: {
        summary: 'Sync accepted',
        value: exampleWorkflowRun,
      },
    },
  },
};
