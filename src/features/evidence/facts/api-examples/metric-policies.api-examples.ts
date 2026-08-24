import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const examplePolicy = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  metric: 'net_operating_income',
  authorityOrder: ['pm-export', 'spreadsheet'],
  stalenessWindowMs: 31536000000,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const metricPoliciesApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    description:
      "The tenant's authored metric policy rows. A metric with no row here resolves " +
      "to the tenant's active metric pack default, not to anything absent.",
    examples: {
      example: {
        summary: 'One authored policy',
        value: { docs: [examplePolicy], count: 1 },
      },
    },
  },
  upserted: {
    status: HttpStatus.OK,
    description: 'The metric policy row after this upsert — a whole-row replace, not a merge.',
    examples: {
      example: {
        summary: 'Upserted policy',
        value: examplePolicy,
      },
    },
  },
  unknownMetric: {
    status: HttpStatus.BAD_REQUEST,
    description: "The metric named in the path is not one the tenant's active metric pack defines.",
    examples: {
      example: {
        summary: 'Unrecognized metric',
        value: {
          statusCode: HttpStatus.BAD_REQUEST,
          message: "'not_a_metric' is not a recognized metric",
          error: 'Bad Request',
        },
      },
    },
  },
  invalidAuthorityOrder: {
    status: HttpStatus.BAD_REQUEST,
    description:
      "authorityOrder repeats a source class at two ranks, or names 'unclassified' — both would " +
      'otherwise pass here and make resolveConflictPolicy silently refuse to propose a winner.',
    examples: {
      duplicateRank: {
        summary: 'A source class repeated at two ranks',
        value: {
          statusCode: HttpStatus.BAD_REQUEST,
          message: ['each value in authorityOrder must be a unique value'],
          error: 'Bad Request',
        },
      },
    },
  },
  reverted: {
    status: HttpStatus.NO_CONTENT,
    description: "The metric now resolves to the tenant's active metric pack default again.",
  },
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description:
      'Caller does not hold the admin role required to author or revert a metric policy.',
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
