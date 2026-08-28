import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AuditEvent,
  type AuditEventDocument,
  type AuditEventOrigin,
} from '../../../database/schemas/audit/audit-event/audit-event.schema';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import {
  DEFAULT_AUDIT_EVENT_SORT_DIRECTION,
  DEFAULT_AUDIT_EVENT_SORT_FIELD,
  type ListAuditEventsRequestDto,
} from './dtos/request/list-audit-events.request.dto';

export interface AuditEventResult {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly subject: { readonly entityType: string; readonly entityId: string };
  readonly timestamp: Date;
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly origin: AuditEventOrigin;
  readonly toolName?: string;
  readonly refusalReason?: string;
  readonly modifiedCount?: number;
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
   * Tenant-scoped read of the audit log. `entityType`/`entityId`/`origin`/`refusalReason` filters
   * are not part of any index this rides (`audit-event.schema.ts`, mirrored in
   * `migrations/0001-baseline.ts`), so a call filtered on one of them scans the tenant's slice
   * rather than seeking straight to matching rows — accepted at this corpus size, not an
   * oversight. `action`, unlike the others, has its own `{tenantId, action}` index (added to back
   * `sort=action`), so a call filtered on it alone seeks.
   *
   * Recording `audit-events.listed` here means reading the audit log is itself audited. That is
   * the point, not a bug: do not "clean up" this call as recursive noise.
   */
  async list(
    dto: ListAuditEventsRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<AuditEventResult>> {
    const filter = {
      tenantId,
      ...(dto.action ? { action: dto.action } : {}),
      ...(dto.entityType ? { 'subject.entityType': dto.entityType } : {}),
      ...(dto.entityId ? { 'subject.entityId': new Types.ObjectId(dto.entityId) } : {}),
      ...(dto.origin ? { origin: dto.origin } : {}),
      ...(dto.refusalReason ? { refusalReason: dto.refusalReason } : {}),
    };

    const [events, count] = await Promise.all([
      this.auditEventModel.find(filter, null, {
        sort: resolveSort(
          dto.sort,
          dto.sortDir,
          DEFAULT_AUDIT_EVENT_SORT_FIELD,
          DEFAULT_AUDIT_EVENT_SORT_DIRECTION,
        ),
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
      origin: event.origin,
      toolName: event.toolName,
      refusalReason: event.refusalReason,
      modifiedCount: event.modifiedCount,
    };
  }
}
