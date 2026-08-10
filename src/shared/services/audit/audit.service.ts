import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Model, Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../database/constants/tenant.constant';
import {
  AuditEvent,
  AuditEventDocument,
} from '../../../database/schemas/audit/audit-event/audit-event.schema';
import { AlsContext } from '../../types/als-context.type';
import { AppLogger } from '../logger/logger.service';

export interface RecordAuditEventInput {
  readonly action: string;
  readonly actorId: string;
  readonly subject: { readonly entityType: string; readonly entityId: string };
  readonly tenantId?: string;
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
    const correlationId = this.als.getStore()?.['correlation-id'] ?? randomUUID();

    const event = await this.auditEventModel.create({
      actor: new Types.ObjectId(input.actorId),
      action: input.action,
      subject: {
        entityType: input.subject.entityType,
        entityId: new Types.ObjectId(input.subject.entityId),
      },
      timestamp: new Date(),
      correlationId,
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
    });

    this.logger.debug(
      `Recorded audit event '${event._id.toString()}' for action '${input.action}'`,
    );
  }
}
