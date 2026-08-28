import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { UserRole } from '../../../../shared/enums/user-role.enum';

const exampleMintedInvitation = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  email: 'colleague@example.com',
  role: UserRole.Member,
  token: 'eo_inv_9f8c12ab34cd56ef',
  expiresAt: '2026-07-08T00:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
};

const exampleInvitation = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  email: 'colleague@example.com',
  role: UserRole.Member,
  expiresAt: '2026-07-08T00:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const invitationsApiExamples: Record<string, ApiResponseOptions> = {
  minted: {
    status: HttpStatus.CREATED,
    description: 'The newly minted invitation, including its plaintext token — shown exactly once.',
    examples: {
      example: {
        summary: 'Minted invitation',
        value: exampleMintedInvitation,
      },
    },
  },
  alreadyRegistered: {
    status: HttpStatus.CONFLICT,
    description: 'The invited email already has an account.',
    examples: {
      example: {
        summary: 'Email already registered',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message: "Email 'colleague@example.com' already has an account",
          error: 'Conflict',
        },
      },
    },
  },
  list: {
    status: HttpStatus.OK,
    description: "The tenant's invitations.",
    examples: {
      example: {
        summary: 'One invitation',
        value: { docs: [exampleInvitation], count: 1 },
      },
    },
  },
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description: 'Only an admin may mint, list, revoke or resend invitations.',
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
  revoked: {
    status: HttpStatus.NO_CONTENT,
    description:
      'The invitation was revoked. Both verify and accept refuse its token from here on.',
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'Invitation does not exist for this tenant, or is already accepted or revoked.',
    examples: {
      example: {
        summary: 'Unknown invitation',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Invitation '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
};
