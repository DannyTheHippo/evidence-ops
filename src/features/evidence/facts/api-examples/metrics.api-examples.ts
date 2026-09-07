import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { MetricResponseDto } from '../dtos/response/metric.response.dto';

export const metricsApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    type: [MetricResponseDto],
    description:
      "Every confirmed measure of the caller's tenant, projected to id, label and canonicalUnit. " +
      'Read-only here; authoring happens under /measures.',
    examples: {
      example: {
        summary: 'Two of the tenant confirmed measures',
        value: [
          { id: 'cap_rate', label: 'Cap Rate', canonicalUnit: 'ratio' },
          { id: 'sale_price', label: 'Sale Price', canonicalUnit: 'usd' },
        ],
      },
    },
  },
};
