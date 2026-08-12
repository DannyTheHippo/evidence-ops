import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { AuthTokenResponseDto } from '../dtos/response/auth-token.response.dto';
import { MeResponseDto } from '../dtos/response/me.response.dto';

const exampleUser = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  email: 'user@example.com',
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const registerApiExamples: Record<string, ApiResponseOptions> = {
  created: {
    status: HttpStatus.CREATED,
    description: 'Account created.',
    type: MeResponseDto,
    examples: {
      example: {
        summary: 'Newly registered account',
        value: exampleUser,
      },
    },
  },
  conflict: {
    status: HttpStatus.CONFLICT,
    description: 'Email is already registered.',
    examples: {
      example: {
        summary: 'Duplicate email',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message: "Email 'user@example.com' is already registered",
          error: 'Conflict',
        },
      },
    },
  },
};

export const loginApiExamples: Record<string, ApiResponseOptions> = {
  success: {
    status: HttpStatus.OK,
    description: 'Authenticated successfully.',
    type: AuthTokenResponseDto,
    examples: {
      example: {
        summary: 'Access token issued',
        value: {
          accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          user: exampleUser,
        },
      },
    },
  },
  unauthorized: {
    status: HttpStatus.UNAUTHORIZED,
    description: 'Invalid email or password.',
    examples: {
      example: {
        summary: 'Invalid credentials',
        value: {
          statusCode: HttpStatus.UNAUTHORIZED,
          message: 'Invalid email or password',
          error: 'Unauthorized',
        },
      },
    },
  },
};

export const logoutApiExamples: Record<string, ApiResponseOptions> = {
  noContent: {
    status: HttpStatus.NO_CONTENT,
    description:
      'Session cookie cleared. The underlying JWT is not revoked and stays valid until it expires.',
  },
  unauthorized: {
    status: HttpStatus.UNAUTHORIZED,
    description: 'No or invalid token provided.',
    examples: {
      example: {
        summary: 'Missing or invalid token',
        value: {
          statusCode: HttpStatus.UNAUTHORIZED,
          message: 'Invalid or expired token',
          error: 'Unauthorized',
        },
      },
    },
  },
};

export const meApiExamples: Record<string, ApiResponseOptions> = {
  success: {
    status: HttpStatus.OK,
    description: 'Current authenticated account.',
    type: MeResponseDto,
    examples: {
      example: {
        summary: 'Current account',
        value: exampleUser,
      },
    },
  },
  unauthorized: {
    status: HttpStatus.UNAUTHORIZED,
    description: 'No or invalid token provided.',
    examples: {
      example: {
        summary: 'Missing or invalid token',
        value: {
          statusCode: HttpStatus.UNAUTHORIZED,
          message: 'Invalid or expired token',
          error: 'Unauthorized',
        },
      },
    },
  },
};
