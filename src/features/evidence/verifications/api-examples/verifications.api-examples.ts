import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { VerificationListResponseDto } from '../dtos/response/verification-list.response.dto';
import { VerificationResponseDto } from '../dtos/response/verification.response.dto';

const exampleVerification = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  requestedBy: { kind: 'pat', id: '65f1c2e4a1b2c3d4e5f6a7b9' },
  claims: ['The cap rate is approximately 6.10%.'],
  results: [{ claimIndex: 0, verdict: 'grounded', citations: [] }],
  advisory:
    'A "grounded" verdict means an independent verifier located supporting evidence for this ' +
    'claim and mechanically checked the citation and every number the claim states against it.',
  retrievedChunkIds: ['chunk-1'],
  atoms: [],
  usage: { promptTokens: 640, completionTokens: 120, costUsd: 0.0031 },
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const verificationsApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    description:
      "Paginated verification run history for the caller's tenant, most recent first, optionally " +
      'filtered by requestedByKind.',
    type: VerificationListResponseDto,
    examples: {
      example: {
        summary: 'One verification run',
        value: { docs: [exampleVerification], count: 1 },
      },
    },
  },
  detail: {
    status: HttpStatus.OK,
    description: 'One verification run.',
    type: VerificationResponseDto,
    examples: {
      example: {
        summary: 'Verification run',
        value: exampleVerification,
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'Verification does not exist.',
    examples: {
      example: {
        summary: 'Unknown verification',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Verification '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
};
