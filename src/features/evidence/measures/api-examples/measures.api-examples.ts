import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { MeasureListResponseDto } from '../dtos/response/measure-list.response.dto';
import { MeasureResponseDto } from '../dtos/response/measure.response.dto';

const exampleMeasure = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  slug: 'cap_rate',
  label: 'Cap Rate',
  aliases: ['Cap Rate', 'capitalization rate'],
  valueType: 'percentage',
  canonicalUnit: 'ratio',
  units: [
    { id: 'ratio', toCanonicalFactor: 1 },
    { id: 'percent', toCanonicalFactor: 0.01 },
  ],
  toleranceKind: 'absolute',
  tolerance: 0.0025,
  stalenessWindowMs: 15_552_000_000,
  status: 'confirmed',
  origin: 'seed',
  proposedFrom: [],
  version: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
};

const exampleConfirmedMeasure = {
  ...exampleMeasure,
  status: 'confirmed',
  version: 2,
  confirmedBy: '65f1c2e4a1b2c3d4e5f6a7c1',
  confirmedAt: '2026-07-02T00:00:00.000Z',
  lastRescan: {
    at: '2026-07-02T00:00:00.000Z',
    status: 'completed',
    durationMs: 42,
    conflictsCreated: 0,
    skippedFactCount: 0,
  },
};

const exampleRejectedMeasure = {
  ...exampleMeasure,
  status: 'rejected',
  rejectedBy: '65f1c2e4a1b2c3d4e5f6a7c1',
  rejectedAt: '2026-07-02T00:00:00.000Z',
  rejectedReason: 'duplicate',
};

export const measuresApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    description: "The tenant's measure registry.",
    type: MeasureListResponseDto,
    examples: {
      example: {
        summary: 'One confirmed measure',
        value: { docs: [exampleMeasure], count: 1 },
      },
    },
  },
  confirmed: {
    status: HttpStatus.OK,
    description: 'The measure row after this confirmation. Triggers a synchronous rescan.',
    type: MeasureResponseDto,
    examples: {
      example: {
        summary: 'Confirmed measure',
        value: exampleConfirmedMeasure,
      },
    },
  },
  rejected: {
    status: HttpStatus.OK,
    description: 'The measure row after this rejection.',
    type: MeasureResponseDto,
    examples: {
      example: {
        summary: 'Rejected measure',
        value: exampleRejectedMeasure,
      },
    },
  },
  updated: {
    status: HttpStatus.OK,
    description: 'The measure row after this edit. Triggers a synchronous rescan.',
    type: MeasureResponseDto,
    examples: {
      example: {
        summary: 'Updated measure',
        value: exampleConfirmedMeasure,
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'No measure with this id exists for the caller’s tenant.',
    examples: {
      example: {
        summary: 'Unknown id',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Measure '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
  notProposed: {
    status: HttpStatus.CONFLICT,
    description: 'This measure is not in the proposed state and cannot be confirmed or rejected.',
    examples: {
      example: {
        summary: 'Already confirmed',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message: "Measure '65f1c2e4a1b2c3d4e5f6a7b8' is 'confirmed', not 'proposed'",
          error: 'Conflict',
        },
      },
    },
  },
  notConfirmed: {
    status: HttpStatus.CONFLICT,
    description: 'This measure is not in the confirmed state and cannot be edited.',
    examples: {
      example: {
        summary: 'Still proposed',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message: "Measure '65f1c2e4a1b2c3d4e5f6a7b8' is 'proposed', not 'confirmed'",
          error: 'Conflict',
        },
      },
    },
  },
  invalidDefinition: {
    status: HttpStatus.BAD_REQUEST,
    description: 'The merged definition (current row plus edits) fails validation.',
    examples: {
      example: {
        summary: 'No factor-1 unit',
        value: {
          statusCode: HttpStatus.BAD_REQUEST,
          message:
            "exactly one unit must have toCanonicalFactor 1 and its id must equal canonicalUnit 'ratio'",
          error: 'Bad Request',
        },
      },
    },
  },
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description: 'Caller does not hold the admin role required to author this registry.',
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
};
