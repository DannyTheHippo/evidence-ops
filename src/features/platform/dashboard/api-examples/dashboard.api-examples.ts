import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { DashboardSummaryResponseDto } from '../dtos/response/dashboard-summary.response.dto';

export const dashboardApiExamples: Record<string, ApiResponseOptions> = {
  summary: {
    status: HttpStatus.OK,
    type: DashboardSummaryResponseDto,
    description: "The caller's tenant, summarized into the counts the Home dashboard needs.",
    examples: {
      example: {
        summary: 'A tenant partway through onboarding',
        value: {
          pendingApprovalCount: 2,
          openConflictCount: 1,
          documentCount: 128,
          sourceCount: 4,
          ingestionFailedCount: 2,
          syncFailedCount: 1,
          needsOcrCount: 3,
          factsFailedCount: 1,
          answerCount: 12,
          hasIngestedDocument: true,
        },
      },
    },
  },
};
