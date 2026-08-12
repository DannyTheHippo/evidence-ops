import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../database/constants/tenant.constant';
import {
  AuditEvent,
  type AuditEventDocument,
} from '../../../database/schemas/audit/audit-event/audit-event.schema';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import type { ListAuditEventsRequestDto } from './dtos/request/list-audit-events.request.dto';

export interface AuditEventResult {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly subject: { readonly entityType: string; readonly entityId: string };
  readonly timestamp: Date;
  readonly correlationId: string;
  readonly createdAt: Date;
}

@Injectable()
export class AuditEventsService {
  constructor(
    @InjectModel(AuditEvent.name)
    private readonly auditEventModel: Model<AuditEventDocument>,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(AuditEventsService.name);
  }

  /**
   * Tenant-scoped read of the audit log. `action`/`entityType`/`entityId` are not part of the
   * `{ tenantId: 1, createdAt: -1 }` index this rides (`0011-tenant-leading-indexes.ts`), so a
   * filtered call scans the tenant's slice rather than seeking straight to matching rows —
   * accepted at this corpus size, not an oversight.
   *
   * Recording `audit-events.listed` here means reading the audit log is itself audited. That is
   * the point, not a bug: do not "clean up" this call as recursive noise.
   */
  async list(
    dto: ListAuditEventsRequestDto,
    actorId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<DocumentResultWithCount<AuditEventResult>> {
    const filter = {
      tenantId,
      ...(dto.action ? { action: dto.action } : {}),
      ...(dto.entityType ? { 'subject.entityType': dto.entityType } : {}),
      ...(dto.entityId ? { 'subject.entityId': new Types.ObjectId(dto.entityId) } : {}),
    };

    const [events, count] = await Promise.all([
      this.auditEventModel.find(filter, null, {
        sort: { createdAt: -1 },
        skip: dto.skip,
        limit: dto.limit,
      }),
      this.auditEventModel.countDocuments(filter),
    ]);

    await this.auditService.record({
      action: 'audit-events.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return { docs: events.map((event) => this.toResult(event)), count };
  }

  private toResult(event: AuditEventDocument): AuditEventResult {
    return {
      id: event._id.toString(),
      actor: event.actor.toString(),
      action: event.action,
      subject: {
        entityType: event.subject.entityType,
        entityId: event.subject.entityId.toString(),
      },
      timestamp: event.timestamp,
      correlationId: event.correlationId,
      createdAt: event.createdAt,
    };
  }
}
