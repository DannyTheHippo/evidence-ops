import type { AuditEventOrigin } from '../../database/schemas/audit/audit-event/audit-event.schema';

export interface AlsContext {
  'correlation-id': string;
  user?: string;
  // Optional because the worker, the eval harness, and migrations all run outside any request
  // and legitimately have no tenant in scope — that absence must stay a no-op, not a failure.
  tenant?: string;
  // Which surface opened this scope. Only the MCP `tools/call` boundary sets it (`'mcp'`);
  // `AuditService.record` reads it so every audit row written anywhere inside that scope — including
  // the ones shared services write for the HTTP path — carries the MCP label without threading an
  // origin argument through those services' signatures. Absent everywhere else, which
  // `AuditService` resolves to `'api'`.
  origin?: AuditEventOrigin;
}
