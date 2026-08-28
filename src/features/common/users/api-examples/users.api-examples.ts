import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { UserRole } from '../../../../shared/enums/user-role.enum';

const exampleUser = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  email: 'colleague@example.com',
  role: UserRole.Member,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const usersApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    description: "The tenant's members.",
    examples: {
      example: {
        summary: 'One member',
        value: { docs: [exampleUser], count: 1 },
      },
    },
  },
  roleChanged: {
    status: HttpStatus.OK,
    description: "The member's updated role.",
    examples: {
      example: {
        summary: 'Role changed',
        value: { ...exampleUser, role: UserRole.Admin },
      },
    },
  },
  removed: {
    status: HttpStatus.NO_CONTENT,
    description: 'The member was removed from the tenant.',
  },
  sessionsRevoked: {
    status: HttpStatus.OK,
    description:
      'Signs the member out of every browser session and disables every API key they hold — ' +
      'raising their session epoch invalidates both, since API keys are checked against the same ' +
      'epoch as session cookies.',
    examples: {
      example: {
        summary: 'Sessions revoked',
        value: exampleUser,
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'User does not exist in this tenant.',
    examples: {
      example: {
        summary: 'Unknown user',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "User '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
  lastAdmin: {
    status: HttpStatus.CONFLICT,
    description: 'This change would leave the tenant with no admin.',
    examples: {
      example: {
        summary: 'Last admin protected',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message:
            "Tenant 'tenant-a' must always keep at least one admin; changing user '65f1c2e4a1b2c3d4e5f6a7b8' to 'member' would leave none",
          error: 'Conflict',
        },
      },
    },
  },
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description: 'Only an admin may manage tenant members.',
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
