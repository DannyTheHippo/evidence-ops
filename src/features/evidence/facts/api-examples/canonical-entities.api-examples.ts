import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { CanonicalEntityResponseDto } from '../dtos/response/canonical-entity.response.dto';
import { ScanNearMatchesResponseDto } from '../dtos/response/scan-near-matches.response.dto';

const exampleHarvestedAlias = {
  alias: 'Property',
  status: 'proposed',
  quote: 'Northgate Business Park (the "Property")',
  locator: { kind: 'pdf-page', page: 4, extractorVersion: 'pdf-1' },
  documentVersionId: '65f1c2e4a1b2c3d4e5f6a7c9',
  harvestedAt: '2026-07-02T00:00:00.000Z',
};

const exampleEntity = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  canonicalName: 'Northgate Business Park',
  aliases: ['Northgate Bus. Park'],
  harvestedAliases: [exampleHarvestedAlias],
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
    type: CanonicalEntityResponseDto,
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
    type: CanonicalEntityResponseDto,
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
  aliasRevoked: {
    status: HttpStatus.OK,
    description: 'The canonical entity row after the harvested alias was revoked.',
    type: CanonicalEntityResponseDto,
    examples: {
      example: {
        summary: 'Revoked alias, no longer resolving',
        value: {
          ...exampleEntity,
          harvestedAliases: [{ ...exampleHarvestedAlias, status: 'revoked' }],
        },
      },
    },
  },
  aliasApplied: {
    status: HttpStatus.OK,
    description: 'The canonical entity row after the proposed harvested alias was applied.',
    type: CanonicalEntityResponseDto,
    examples: {
      example: {
        summary: 'Applied alias, now resolving',
        value: {
          ...exampleEntity,
          harvestedAliases: [{ ...exampleHarvestedAlias, status: 'applied' }],
        },
      },
    },
  },
  nearMatchesScanned: {
    status: HttpStatus.OK,
    description:
      'Proposals recorded for this scan. Each lands as a proposed harvestedAliases entry on the ' +
      'row it was attributed to; a subsequent GET surfaces it for review.',
    type: ScanNearMatchesResponseDto,
    examples: {
      example: {
        summary: 'Two near matches proposed',
        value: { proposed: 2 },
      },
    },
  },
  aliasNotFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'This alias group carries no harvested alias by that name.',
    examples: {
      example: {
        summary: 'Unknown alias',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Alias group '65f1c2e4a1b2c3d4e5f6a7b8' has no harvested alias 'Property'",
          error: 'Not Found',
        },
      },
    },
  },
  aliasNotProposed: {
    status: HttpStatus.CONFLICT,
    description: 'This harvested alias is not in the proposed state and cannot be applied again.',
    examples: {
      example: {
        summary: 'Already applied or revoked',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message:
            "Harvested alias 'Property' on alias group '65f1c2e4a1b2c3d4e5f6a7b8' is 'revoked', not 'proposed'",
          error: 'Conflict',
        },
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: "No alias group with this id exists for the caller's tenant.",
    examples: {
      example: {
        summary: 'Unknown id',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Alias group '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
  nameConflict: {
    status: HttpStatus.CONFLICT,
    description: 'An alias group with this name already exists for this tenant.',
    examples: {
      example: {
        summary: 'Duplicate canonical name',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message: "An alias group named 'Northgate Business Park' already exists for this tenant",
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
