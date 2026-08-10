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
  citations: [],
  conflictIds: [],
  createdAt: '2026-07-01T00:00:00.000Z',
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
};
