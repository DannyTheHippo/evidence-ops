import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const exampleEntity = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  canonicalName: 'Northgate Business Park',
  aliases: ['Northgate Bus. Park'],
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const canonicalEntitiesApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    description: "The tenant's registered canonical entities.",
    examples: {
      example: {
        summary: 'One registered entity',
        value: { docs: [exampleEntity], count: 1 },
      },
    },
  },
  created: {
    status: HttpStatus.CREATED,
    description: 'The canonical entity row that was created.',
    examples: {
      example: {
        summary: 'Created entity',
        value: exampleEntity,
      },
    },
  },
  updated: {
    status: HttpStatus.OK,
    description: 'The canonical entity row after this update.',
    examples: {
      example: {
        summary: 'Updated entity',
        value: exampleEntity,
      },
    },
  },
  removed: {
    status: HttpStatus.NO_CONTENT,
    description: 'The canonical entity row was deleted.',
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: "No canonical entity with this id exists for the caller's tenant.",
    examples: {
      example: {
        summary: 'Unknown id',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Canonical entity '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
  nameConflict: {
    status: HttpStatus.CONFLICT,
    description: 'A canonical entity with this name already exists for this tenant.',
    examples: {
      example: {
        summary: 'Duplicate canonical name',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message:
            "A canonical entity named 'Northgate Business Park' already exists for this tenant",
          error: 'Conflict',
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
