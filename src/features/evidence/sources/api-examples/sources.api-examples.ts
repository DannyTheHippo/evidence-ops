import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { SourceWithFileStatesResponseDto } from '../dtos/response/source-with-file-states.response.dto';

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
  connectivity: 'connector',
  reachability: 'live',
  owner: 'Jane Doe, IT',
  tracked: true,
  sourceClass: 'unclassified',
  createdAt: '2026-07-01T00:00:00.000Z',
};

const exampleFileState = {
  path: 'contracts/lease-agreement.pdf',
  status: 'failed',
  lastError: "Could not resolve a document type for 'contracts/lease-agreement.pdf'",
  mtimeMs: 1753920000000,
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
  detail: {
    status: HttpStatus.OK,
    description: 'The requested source, with per-file sync state.',
    type: SourceWithFileStatesResponseDto,
    examples: {
      example: {
        summary: 'Source with one failed file',
        value: { ...exampleSource, fileStates: [exampleFileState] },
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
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description: 'Caller does not hold the admin role required to create or reconfigure a source.',
    examples: {
      example: {
        summary: 'Insufficient role',
        value: {
          statusCode: HttpStatus.FORBIDDEN,
          message: 'Insufficient role for this action',
          error: 'Forbidden',
        },
      },
    },
  },
  classDrift: {
    status: HttpStatus.OK,
    description: 'How many documents from this source still carry a superseded sourceClass.',
    examples: {
      drifted: {
        summary: 'Documents still carry the previous class',
        value: { previousClass: 'memo', count: 12 },
      },
      none: {
        summary: 'sourceClass has never changed for this source',
        value: { count: 0 },
      },
    },
  },
  classDriftApplied: {
    status: HttpStatus.OK,
    description:
      "The result of applying this source's current sourceClass to every document that still " +
      'carried the previous one.',
    examples: {
      example: {
        summary: 'Applied to 12 documents',
        value: { modifiedCount: 12, previousClass: 'memo', sourceClass: 'crm-export' },
      },
    },
  },
};
