import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { ConflictResponseDto } from '../dtos/response/conflict.response.dto';

const exampleConflict = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
  factIds: ['65f1c2e4a1b2c3d4e5f6a7b9', '65f1c2e4a1b2c3d4e5f6a7ba'],
  values: [
    {
      factId: '65f1c2e4a1b2c3d4e5f6a7b9',
      value: 5.25,
      unit: 'percent',
      sourceChunkId: 'chunk-xlsx',
      documentVersionId: '65f1c2e4a1b2c3d4e5f6a7c0',
      locator: { kind: 'xlsx-cell', extractorVersion: 'v1', sheetName: 'Comps', cell: 'F2' },
    },
    {
      factId: '65f1c2e4a1b2c3d4e5f6a7ba',
      value: 6.1,
      unit: 'percent',
      sourceChunkId: 'chunk-prose',
      documentVersionId: '65f1c2e4a1b2c3d4e5f6a7c1',
      locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
    },
  ],
  magnitude: 0.0085,
  magnitudeUnit: 'ratio',
  status: 'open',
  createdAt: '2026-07-01T00:00:00.000Z',
  // `cap_rate` has no configured `authorityOrder` (see `metric-ontology.ts`), so the survivorship
  // policy declines to propose a winner and `proposedWinnerFactId` is absent.
  ruleFired: 'none',
  explanation: 'No authorityOrder is configured for this metric.',
};

const exampleResolutionRequestedRun = {
  id: '65f1c2e4a1b2c3d4e5f6a7bb',
  workflowId: 'a3f1b2c4-5678-4d9e-9abc-1234567890ab',
  status: 'running',
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const conflictsApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    type: [ConflictResponseDto],
    description: 'Paginated list of detected conflicts.',
    examples: {
      example: {
        summary: 'One open conflict',
        value: { docs: [exampleConflict], count: 1 },
      },
    },
  },
  resolutionRequested: {
    status: HttpStatus.CREATED,
    description:
      'A resolveConflict workflow was started to gate the proposed winner behind a human.',
    examples: {
      example: {
        summary: 'Resolution requested',
        value: exampleResolutionRequestedRun,
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'Conflict does not exist.',
    examples: {
      example: {
        summary: 'Unknown conflict',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Conflict '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
  invalidResolution: {
    status: HttpStatus.CONFLICT,
    description: 'Conflict is not open, or winningFactId is not one of its own facts.',
    examples: {
      example: {
        summary: 'Not open',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message:
            "Conflict '65f1c2e4a1b2c3d4e5f6a7b8' is 'resolved', not 'open' — it cannot be resolved again",
          error: 'Conflict',
        },
      },
    },
  },
};
