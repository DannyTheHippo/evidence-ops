import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const examplePendingApproval = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  subject: { entityType: 'Conflict', entityId: '65f1c2e4a1b2c3d4e5f6a7b9' },
  action: 'resolve_conflict',
  summary: 'Resolve Northgate Business Park cap_rate (2025-03) in favor of 5.25% over 6.10%.',
  requestedBy: 'analyst@example.com',
  workflowId: 'a3f1b2c4-5678-4d9e-9abc-1234567890ab',
  state: 'pending',
  createdAt: '2026-07-01T00:00:00.000Z',
};

const exampleDecidedApproval = {
  ...examplePendingApproval,
  state: 'approved',
  decidedBy: 'reviewer@example.com',
  decidedAt: '2026-07-02T00:00:00.000Z',
  decisionReason: 'Evidence checks out.',
};

export const approvalsApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    description: 'Paginated pending-approval inbox.',
    examples: {
      example: {
        summary: 'One pending approval',
        value: { docs: [examplePendingApproval], count: 1 },
      },
    },
  },
  decided: {
    status: HttpStatus.OK,
    description: 'The approval after recording the decision.',
    examples: {
      example: {
        summary: 'Approved',
        value: exampleDecidedApproval,
      },
    },
  },
  notFound: {
    status: HttpStatus.NOT_FOUND,
    description: 'Approval does not exist for this tenant.',
    examples: {
      example: {
        summary: 'Unknown approval',
        value: {
          statusCode: HttpStatus.NOT_FOUND,
          message: "Approval '65f1c2e4a1b2c3d4e5f6a7b8' not found",
          error: 'Not Found',
        },
      },
    },
  },
  alreadyDecided: {
    status: HttpStatus.CONFLICT,
    description: 'Approval was already decided.',
    examples: {
      example: {
        summary: 'Already approved',
        value: {
          statusCode: HttpStatus.CONFLICT,
          message:
            "Approval '65f1c2e4a1b2c3d4e5f6a7b8' is already 'approved' — a decision cannot be re-applied",
          error: 'Conflict',
        },
      },
    },
  },
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description: 'Caller does not hold the admin role required to decide an approval.',
    examples: {
      example: {
        summary: 'Insufficient role',
        value: {
          statusCode: HttpStatus.FORBIDDEN,
          message: 'Insufficient role for this action',
          error: 'Forbidden',
        },
      },
    },
  },
};
