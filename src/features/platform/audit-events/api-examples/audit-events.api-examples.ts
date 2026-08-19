import { HttpStatus } from '@nestjs/common';
import type { ApiResponseOptions } from '@nestjs/swagger';

const exampleAuditEvent = {
  id: '65f1c2e4a1b2c3d4e5f6a7b8',
  actor: '65f1c2e4a1b2c3d4e5f6a7c0',
  action: 'approvals.decided',
  subject: { entityType: 'Approval', entityId: '65f1c2e4a1b2c3d4e5f6a7b9' },
  timestamp: '2026-07-02T00:00:00.000Z',
  correlationId: 'a3f1b2c4-5678-4d9e-9abc-1234567890ab',
  createdAt: '2026-07-02T00:00:00.000Z',
  origin: 'api',
};

const exampleMcpAuditEvent = {
  id: '65f1c2e4a1b2c3d4e5f6a7bb',
  actor: '65f1c2e4a1b2c3d4e5f6a7c1',
  action: 'mcp.tool_call.refused',
  subject: { entityType: 'Answer', entityId: '65f1c2e4a1b2c3d4e5f6a7bc' },
  timestamp: '2026-07-02T00:05:00.000Z',
  correlationId: 'b4a2c3d5-6789-4e0f-9abc-2234567890ac',
  createdAt: '2026-07-02T00:05:00.000Z',
  origin: 'mcp',
  toolName: 'get_answer',
  refusalReason: 'authz-denied',
};

export const auditEventsApiExamples: Record<string, ApiResponseOptions> = {
  list: {
    status: HttpStatus.OK,
    description: 'Paginated audit log, most recent first, optionally filtered.',
    examples: {
      example: {
        summary: 'One API-origin row, one MCP-origin refusal',
        value: { docs: [exampleAuditEvent, exampleMcpAuditEvent], count: 2 },
      },
    },
  },
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description: 'Caller does not hold the admin role required to read the audit log.',
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
