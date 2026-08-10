import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const exampleConflict = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
  factIds: ['65f1c2e4a1b2c3d4e5f6a7b9', '65f1c2e4a1b2c3d4e5f6a7ba'],
  magnitude: 0.0085,
  status: 'open',
  createdAt: '2026-07-01T00:00:00.000Z',
};

export const conflictsApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    description: 'Paginated list of detected conflicts.',
    examples: {
      example: {
        summary: 'One open conflict',
        value: { docs: [exampleConflict], count: 1 },
      },
    },
  },
};
