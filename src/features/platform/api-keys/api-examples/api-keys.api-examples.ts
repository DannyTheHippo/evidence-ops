import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const exampleMintedKey = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  name: 'CI integration',
  token: 'eo_pat_9f8c12ab34cd56ef',
  tokenPrefix: 'eo_pat_9f8c12',
  expiresAt: '2026-12-31T00:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
};

const exampleKey = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  name: 'CI integration',
  tokenPrefix: 'eo_pat_9f8c12',
  expiresAt: '2026-12-31T00:00:00.000Z',
  lastUsedAt: '2026-08-01T00:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const apiKeysApiExamples: Record<string, ApiResponseOptions> = {
  minted: {
    status: HttpStatus.CREATED,
    description: 'The newly minted key, including its plaintext token — shown exactly once.',
    examples: {
      example: {
        summary: 'Minted API key',
        value: exampleMintedKey,
      },
    },
  },
  list: {
    status: HttpStatus.OK,
    description: "The caller's own API keys.",
    examples: {
      example: {
        summary: 'One key',
        value: { docs: [exampleKey], count: 1 },
      },
    },
  },
  limitExceeded: {
    status: HttpStatus.CONFLICT,
    description: 'The caller already has the maximum number of active API keys.',
    examples: {
      example: {
        summary: 'Active key cap reached',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message:
            "User '65f1c2e4a1b2c3d4e5f6a7b8' already has 10 active API keys, the maximum allowed",
          error: 'Conflict',
        },
      },
    },
  },
  revoked: {
    status: HttpStatus.NO_CONTENT,
    description: 'The key was revoked.',
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'API key does not exist for this user.',
    examples: {
      example: {
        summary: 'Unknown key',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "API key '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
};
