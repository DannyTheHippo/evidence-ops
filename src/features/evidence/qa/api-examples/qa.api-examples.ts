import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { AnswerResponseDto } from '../dtos/response/answer.response.dto';
import { StartQuestionResponseDto } from '../dtos/response/start-question.response.dto';

const exampleQueuedAnswer = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  runStatus: 'queued',
};

const exampleCompletedAnswer = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  questionText: 'What is the cap rate for Northgate Business Park in Q1 2025?',
  runStatus: 'completed',
  outcome: {
    kind: 'answered',
    claims: [{ statement: 'The cap rate is approximately 6.10%.', citations: [] }],
  },
  claimCoverage: 1,
  retrievedChunkCount: 8,
  verificationReport: { verifiedClaimCount: 1, totalClaimCount: 1, droppedClaims: [] },
  citations: [],
  atoms: [],
  conflictIds: [],
  createdAt: '2026-07-01T00:00:00.000Z',
  // QA synthesis spend only — not embedding or extraction spend.
  usage: { promptTokens: 1240, completionTokens: 180, costUsd: 0.0042 },
};

export const qaApiExamples: Record<string, ApiResponseOptions> = {
  started: {
    status: HttpStatus.CREATED,
    description: 'Question accepted; a workflow was started to produce the answer.',
    type: StartQuestionResponseDto,
    examples: {
      example: {
        summary: 'Queued answer',
        value: exampleQueuedAnswer,
      },
    },
  },
  validationError: {
    status: HttpStatus.BAD_REQUEST,
    description: 'questionText is missing, empty, or not a string.',
    examples: {
      example: {
        summary: 'Empty questionText',
        value: {
          statusCode: HttpStatus.BAD_REQUEST,
          message: ['questionText should not be empty'],
          error: 'Bad Request',
        },
      },
    },
  },
  answerDetail: {
    status: HttpStatus.OK,
    description:
      'Server-computed answer envelope. `outcome` is present only once runStatus is completed.',
    type: AnswerResponseDto,
    examples: {
      example: {
        summary: 'Completed answer',
        value: exampleCompletedAnswer,
      },
    },
  },
  answersList: {
    status: HttpStatus.OK,
    description:
      "Paginated answer history for the caller's tenant, most recent first, optionally filtered " +
      'by runStatus.',
    examples: {
      example: {
        summary: 'One completed answer',
        value: { docs: [exampleCompletedAnswer], count: 1 },
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'Answer does not exist.',
    examples: {
      example: {
        summary: 'Unknown answer',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Answer '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
  answerStream: {
    status: HttpStatus.OK,
    description:
      'text/event-stream. Polls every 1.5s until runStatus reaches a terminal state, emitting the ' +
      'final state before closing. `answer` events carry the exact shape GET /answers/:id returns; ' +
      'a `heartbeat` event fires every 15s; a terminal `error` event means the client should fall ' +
      'back to polling GET /answers/:id. Re-checks the connecting session every 30s and closes if ' +
      'it is gone or moved tenants.',
  },
  streamConnectionLimitExceeded: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: "The caller's tenant or user is already at its open-SSE-stream cap.",
    examples: {
      example: {
        summary: 'Open-stream cap reached',
        value: {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: "User 'user-1' is at its open-stream limit (10)",
          error: 'Too Many Requests',
        },
      },
    },
  },
};
