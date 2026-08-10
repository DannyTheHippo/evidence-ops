import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { HealthResponseDto } from '../dtos/response/health.response.dto';

export const getHealthApiExamples: Record<string, ApiResponseOptions> = {
  success: {
    status: HttpStatus.OK,
    type: HealthResponseDto,
    description: 'Health check status returned.',
    examples: {
      example: {
        summary: 'Health check status',
        value: {
          status: 'ok',
          mongo: 'up',
        },
      },
    },
  },
};
