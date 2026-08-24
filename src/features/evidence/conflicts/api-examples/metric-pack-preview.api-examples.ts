import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const examplePreview = {
  metrics: [
    { metricId: 'cap_rate', wouldCreate: 0, wouldRetract: 3 },
    { metricId: 'sale_price', wouldCreate: 2, wouldRetract: 0 },
  ],
};

export const metricPackPreviewApiExamples: Record<string, ApiResponseOptions> = {
  previewed: {
    status: HttpStatus.OK,
    description:
      'Per-metric would-create/would-retract counts for activating this version right now, ' +
      "computed against the tenant's existing facts without writing anything. Only metrics whose " +
      'detection-relevant configuration actually changed appear — a labels-only draft previews as ' +
      '{ metrics: [] }.',
    examples: {
      example: {
        summary: 'A tolerance loosened on one metric, tightened on another',
        value: examplePreview,
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'The named packId/version does not exist for this tenant.',
    examples: {
      example: {
        summary: 'Unknown version',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Pack 'cre-fork' v9 does not exist for this tenant",
          error: 'Not Found',
        },
      },
    },
  },
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description: 'Caller does not hold the admin role required to preview a metric pack version.',
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
