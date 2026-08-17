import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Model, Types } from 'mongoose';
import {
  AuditEvent,
  AuditEventDocument,
  type AuditEventOrigin,
} from '../../../database/schemas/audit/audit-event/audit-event.schema';
import { AlsContext } from '../../types/als-context.type';
import { AppLogger } from '../logger/logger.service';

export interface RecordAuditEventInput {
  readonly action: string;
  readonly actorId: string;
  readonly subject: { readonly entityType: string; readonly entityId: string };
  readonly tenantId: string;
  /** Which surface the action came through, when the caller knows it first-hand. Omitted by every
   * caller that is not the surface itself: `record` then reads `AlsContext.origin`, so a shared
   * service called from inside an MCP `tools/call` scope labels its row `'mcp'` without knowing
   * anything about MCP, and falls back to `'api'` outside one. */
  readonly origin?: AuditEventOrigin;
  /** MCP `tools/call` rows only — see `AuditEvent.toolName`/`AuditEvent.refusalReason` for what
   * each holds and what deliberately never reaches them. */
  readonly toolName?: string;
  readonly refusalReason?: string;
}

/**
 * `correlationId` falls back to a fresh UUID rather than throwing when the ALS store is
 * unexpectedly empty — mirrors `AsyncLocalStorageMiddleware`'s own fallback. The audit write is a
 * required side effect of the calling request, not a veto gate on it; a missing store should not
 * be able to happen (every routed request passes through the middleware) but must not crash the
 * write if it somehow does.
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditEvent.name)
    private readonly auditEventModel: Model<AuditEventDocument>,

    @Inject(AsyncLocalStorage)
    private readonly als: AsyncLocalStorage<AlsContext>,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(AuditService.name);
  }

  async record(input: RecordAuditEventInput): Promise<void> {
    const store = this.als.getStore();
    const correlationId = store?.['correlation-id'] ?? randomUUID();

    const event = await this.auditEventModel.create({
      actor: new Types.ObjectId(input.actorId),
      action: input.action,
      subject: {
        entityType: input.subject.entityType,
        entityId: new Types.ObjectId(input.subject.entityId),
      },
      timestamp: new Date(),
      correlationId,
      origin: input.origin ?? store?.origin ?? 'api',
      toolName: input.toolName,
      refusalReason: input.refusalReason,
      tenantId: input.tenantId,
    });

    this.logger.debug(
      `Recorded audit event '${event._id.toString()}' for action '${input.action}'`,
    );
  }
}
