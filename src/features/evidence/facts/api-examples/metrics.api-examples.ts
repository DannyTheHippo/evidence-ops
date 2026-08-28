import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';
import { MetricResponseDto } from '../dtos/response/metric.response.dto';

export const metricsApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    type: [MetricResponseDto],
    description:
      'Every metric METRIC_ONTOLOGY defines, projected to its id, label and canonicalUnit. ' +
      'Read-only: there is no endpoint to add, edit or remove a metric.',
    examples: {
      example: {
        summary: 'Two of the built-in metrics',
        value: [
          { id: 'cap_rate', label: 'Cap Rate', canonicalUnit: 'ratio' },
          { id: 'sale_price', label: 'Sale Price', canonicalUnit: 'usd' },
        ],
      },
    },
  },
};
