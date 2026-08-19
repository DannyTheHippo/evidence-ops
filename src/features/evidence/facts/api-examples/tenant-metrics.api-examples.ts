import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const exampleTenantMetric = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  metricId: 'cap_rate',
  label: 'Capitalization Rate',
  isCustom: false,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const tenantMetricsApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    description:
      "The tenant's authored measure labels. A measure with no row here displays under its code " +
      'ontology label (or is absent from the catalog entirely, for a metricId outside METRIC_IDS).',
    examples: {
      example: {
        summary: 'One authored label',
        value: { docs: [exampleTenantMetric], count: 1 },
      },
    },
  },
  upserted: {
    status: HttpStatus.OK,
    description:
      'The tenant metric row after this upsert. Renames a code-ontology metric when the path id ' +
      "matches one of METRIC_IDS's members, or adds a new catalog entry otherwise.",
    examples: {
      example: {
        summary: 'Upserted label',
        value: exampleTenantMetric,
      },
    },
  },
  invalidMetricId: {
    status: HttpStatus.BAD_REQUEST,
    description: 'The metricId in the path is not lowercase snake_case.',
    examples: {
      example: {
        summary: 'Malformed metric id',
        value: {
          statusCode: HttpStatus.BAD_REQUEST,
          message: "'Not A Metric!' is not a valid metric id — expected lowercase snake_case",
          error: 'Bad Request',
        },
      },
    },
  },
  removed: {
    status: HttpStatus.NO_CONTENT,
    description:
      'The measure now displays under its code ontology label again, or — for a tenant-added ' +
      'measure — no longer appears in the catalog at all.',
  },
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description:
      'Caller does not hold the admin role required to author or revert a tenant metric label.',
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
