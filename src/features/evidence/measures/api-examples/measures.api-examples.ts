import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const exampleMeasures = {
  answersCompleted: 42,
  answersWithVerifiedCitations: 37,
  conflictsSurfaced: 12,
  conflictsResolved: 9,
  meanEvidenceDocumentsPerAnswer: 3.4,
  medianAnswerLatencyMs: 4200,
  p95AnswerLatencyMs: 9800,
};

export const measuresApiExamples: Record<string, ApiResponseOptions> = {
  get: {
    status: HttpStatus.OK,
    description:
      'Four tenant-scoped pilot measures, derived entirely from data the platform already holds. ' +
      'meanEvidenceDocumentsPerAnswer, medianAnswerLatencyMs and p95AnswerLatencyMs are null, ' +
      'never 0, when answersCompleted is 0.',
    examples: {
      example: {
        summary: 'A tenant with completed answers and conflicts',
        value: exampleMeasures,
      },
    },
  },
};
