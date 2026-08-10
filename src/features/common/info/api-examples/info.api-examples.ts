import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { InfoResponseDto } from '../dtos/response/info.response.dto';

export const getInfoApiExamples: Record<string, ApiResponseOptions> = {
  success: {
    status: HttpStatus.OK,
    type: InfoResponseDto,
    description: 'App version returned.',
    examples: {
      example: {
        summary: 'App version',
        value: {
          version: '1.0.0',
        },
      },
    },
  },
};
