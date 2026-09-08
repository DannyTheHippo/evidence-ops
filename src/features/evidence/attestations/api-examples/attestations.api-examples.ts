import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { AttestationBundleResponseDto } from '../dtos/response/attestation-bundle.response.dto';

const exampleBundle = {
  schemaVersion: 1,
  kind: 'answer',
  subjectId: '65f1c2e4a1b2c3d4e5f6a7b8',
  tenantId: 'tenant-a',
  producedAt: '2026-07-01T00:00:00.000Z',
  subject: { question: 'What is the cap rate for Northgate Business Park in Q1 2025?' },
  outcome: 'answered',
  claims: [
    {
      statement: 'The cap rate is approximately 6.10%.',
      verdict: 'survived',
      citations: [
        {
          documentId: '65f1c2e4a1b2c3d4e5f6a7b9',
          documentVersionId: '65f1c2e4a1b2c3d4e5f6a7ba',
          sha256: 'a'.repeat(64),
          locator: { kind: 'pdf-page', page: 3, extractorVersion: 'v1' },
          extractorVersion: 'v1',
          quote: 'at a cap rate of approximately 6.10%',
        },
      ],
      checks: [
        { name: 'retrieval-containment', passed: true },
        { name: 'quote-containment', passed: true },
        { name: 'quote-alignment', passed: true },
        { name: 'numeric-support', passed: true },
      ],
    },
  ],
  decisions: [],
  measures: [{ slug: 'cap_rate', version: 3, status: 'confirmed' }],
  integrity: { algorithm: 'sha256', contentHash: 'b'.repeat(64) },
};

export const attestationsApiExamples: Record<string, ApiResponseOptions> = {
  bundle: {
    status: HttpStatus.OK,
    description:
      'Tamper-evident export of a completed answer or a verification. integrity.contentHash is a ' +
      'sha256 over the canonical JSON of every other field, pinned on the subject the first time ' +
      'it is exported — a second export of an unchanged subject reproduces the same bundle and hash.',
    type: AttestationBundleResponseDto,
    examples: {
      example: {
        summary: 'Answer attestation bundle',
        value: exampleBundle,
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'Answer or verification does not exist.',
    examples: {
      example: {
        summary: 'Unknown subject',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Answer '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
  notComplete: {
    status: HttpStatus.CONFLICT,
    description: 'The answer has not finished running yet.',
    examples: {
      example: {
        summary: 'Queued answer',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message: "Answer '65f1c2e4a1b2c3d4e5f6a7b8' is not completed",
          error: 'Conflict',
        },
      },
    },
  },
};
