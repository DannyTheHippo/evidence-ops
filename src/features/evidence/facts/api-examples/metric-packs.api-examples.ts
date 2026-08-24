import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const exampleMetric = {
  id: 'cap_rate',
  label: 'Cap Rate',
  aliases: ['Cap Rate', 'cap rate'],
  valueType: 'percentage',
  canonicalUnit: 'ratio',
  units: [
    { id: 'ratio', toCanonicalFactor: 1 },
    { id: 'percent', toCanonicalFactor: 0.01 },
  ],
  toleranceKind: 'absolute',
  tolerance: 0.0025,
  authorityOrder: ['pm-export'],
  stalenessWindowMs: 15552000000,
};

const examplePack = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  packId: 'cre-fork',
  version: 2,
  status: 'draft',
  label: 'CRE Fork',
  metrics: [exampleMetric],
  parentPackId: 'cre',
  parentVersion: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const metricPacksApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    description: "The tenant's authored pack versions, across every packId, draft through retired.",
    examples: {
      example: {
        summary: 'One authored version',
        value: { docs: [examplePack], count: 1 },
      },
    },
  },
  created: {
    status: HttpStatus.CREATED,
    description:
      'The new draft, versioned one past whatever this packId already has for this tenant.',
    examples: {
      example: {
        summary: 'Created draft',
        value: examplePack,
      },
    },
  },
  published: {
    status: HttpStatus.OK,
    description: 'The version after publish — now frozen and immutable.',
    examples: {
      example: {
        summary: 'Published version',
        value: { ...examplePack, status: 'published' },
      },
    },
  },
  activated: {
    status: HttpStatus.OK,
    description: "The version after activate — now the tenant's active pack.",
    examples: {
      example: {
        summary: 'Activated version',
        value: { ...examplePack, status: 'active' },
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
  parentNotFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'The named parentVersion does not exist for this tenant under this packId.',
    examples: {
      example: {
        summary: 'Unknown parent version',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Parent version 9 of pack 'cre-fork' does not exist for this tenant",
          error: 'Not Found',
        },
      },
    },
  },
  notDraft: {
    status: HttpStatus.CONFLICT,
    description: 'The named version is not currently draft — only a draft can be published.',
    examples: {
      example: {
        summary: 'Already published',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message:
            "Pack 'cre-fork' v2 is 'published', not 'draft' — only a draft can be " +
            'published, and a published version is immutable',
          error: 'Conflict',
        },
      },
    },
  },
  notPublished: {
    status: HttpStatus.CONFLICT,
    description:
      'The named version is not currently published — only a published version can be activated.',
    examples: {
      example: {
        summary: 'Still a draft',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message:
            "Pack 'cre-fork' v2 is 'draft', not 'published' — only a published version can " +
            'be activated',
          error: 'Conflict',
        },
      },
    },
  },
  unacknowledgedRemoval: {
    status: HttpStatus.CONFLICT,
    description:
      'Publishing would drop a metric the parent version defined without acknowledging the removal.',
    examples: {
      example: {
        summary: 'Unacknowledged metric removal',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message:
            "Publishing pack 'cre-fork' v2 would drop metric(s) lease_term_years present in the " +
            'parent version — acknowledge the removal explicitly or restore the metric',
          error: 'Conflict',
        },
      },
    },
  },
  frozenArithmetic: {
    status: HttpStatus.CONFLICT,
    description:
      "Publishing would change a surviving metric's canonicalUnit or an existing unit's " +
      'toCanonicalFactor relative to the parent version.',
    examples: {
      example: {
        summary: 'Conversion factor changed',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message:
            "Unit 'usd_thousands' of metric 'sale_price' changes toCanonicalFactor in pack " +
            "'cre-fork' v2 — see canonicalUnit's refusal above for why a factor edit cannot be " +
            'made honest by a version stamp',
          error: 'Conflict',
        },
      },
    },
  },
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description: 'Caller does not hold the admin role required to author a metric pack version.',
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
