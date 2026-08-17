import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { AuditEvent } from '../../../../src/database/schemas/audit/audit-event/audit-event.schema';
import { AuditEventsService } from '../../../../src/features/platform/audit-events/audit-events.service';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('AuditEventsService', () => {
  let service: AuditEventsService;

  const mockAuditEventModel = getMockModel();
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  const buildEvent = (overrides: Partial<Record<string, unknown>> = {}) => ({
    _id: new Types.ObjectId(),
    actor: new Types.ObjectId(),
    action: 'approvals.decided',
    subject: { entityType: 'Approval', entityId: new Types.ObjectId() },
    timestamp: new Date('2026-07-02T00:00:00.000Z'),
    correlationId: 'a3f1b2c4-5678-4d9e-9abc-1234567890ab',
    createdAt: new Date('2026-07-02T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditEventsService,
        { provide: getModelToken(AuditEvent.name), useValue: mockAuditEventModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<AuditEventsService>(AuditEventsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('list', () => {
    it('should list events for a tenant with no filters, and record its own listed event', async () => {
      const actorId = new Types.ObjectId().toString();
      const event = buildEvent();
      mockAuditEventModel.find.mockResolvedValueOnce([event]);
      mockAuditEventModel.countDocuments.mockResolvedValueOnce(1);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.list({ skip: 0, limit: 20 }, actorId, 'tenant-a');

      expect(mockAuditEventModel.find).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockAuditEventModel.countDocuments).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'audit-events.listed',
        actorId,
        subject: { entityType: 'User', entityId: actorId },
        tenantId: 'tenant-a',
      });
      expect(result).toEqual({
        docs: [
          {
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
          },
        ],
        count: 1,
      });
    });

    it('should scope the lookup to an explicit tenantId when provided', async () => {
      const actorId = new Types.ObjectId().toString();
      mockAuditEventModel.find.mockResolvedValueOnce([]);
      mockAuditEventModel.countDocuments.mockResolvedValueOnce(0);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      await service.list({ skip: 0, limit: 20 }, actorId, 'acme-corp');

      expect(mockAuditEventModel.find).toHaveBeenCalledWith({ tenantId: 'acme-corp' }, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockAuditEventModel.countDocuments).toHaveBeenCalledWith({ tenantId: 'acme-corp' });
    });

    it('should filter by action alone', async () => {
      const actorId = new Types.ObjectId().toString();
      mockAuditEventModel.find.mockResolvedValueOnce([]);
      mockAuditEventModel.countDocuments.mockResolvedValueOnce(0);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      await service.list({ skip: 0, limit: 20, action: 'approvals.decided' }, actorId, 'tenant-a');

      const expectedFilter = { tenantId: 'tenant-a', action: 'approvals.decided' };
      expect(mockAuditEventModel.find).toHaveBeenCalledWith(expectedFilter, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockAuditEventModel.countDocuments).toHaveBeenCalledWith(expectedFilter);
    });

    it('should filter by entityType alone', async () => {
      const actorId = new Types.ObjectId().toString();
      mockAuditEventModel.find.mockResolvedValueOnce([]);
      mockAuditEventModel.countDocuments.mockResolvedValueOnce(0);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      await service.list({ skip: 0, limit: 20, entityType: 'Approval' }, actorId, 'tenant-a');

      const expectedFilter = { tenantId: 'tenant-a', 'subject.entityType': 'Approval' };
      expect(mockAuditEventModel.find).toHaveBeenCalledWith(expectedFilter, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockAuditEventModel.countDocuments).toHaveBeenCalledWith(expectedFilter);
    });

    it('should filter by entityId alone', async () => {
      const actorId = new Types.ObjectId().toString();
      const entityId = new Types.ObjectId().toString();
      mockAuditEventModel.find.mockResolvedValueOnce([]);
      mockAuditEventModel.countDocuments.mockResolvedValueOnce(0);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      await service.list({ skip: 0, limit: 20, entityId }, actorId, 'tenant-a');

      const expectedFilter = {
        tenantId: 'tenant-a',
        'subject.entityId': new Types.ObjectId(entityId),
      };
      expect(mockAuditEventModel.find).toHaveBeenCalledWith(expectedFilter, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockAuditEventModel.countDocuments).toHaveBeenCalledWith(expectedFilter);
    });

    it('should combine action, entityType, and entityId when all three are given', async () => {
      const actorId = new Types.ObjectId().toString();
      const entityId = new Types.ObjectId().toString();
      mockAuditEventModel.find.mockResolvedValueOnce([]);
      mockAuditEventModel.countDocuments.mockResolvedValueOnce(0);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      await service.list(
        { skip: 0, limit: 20, action: 'approvals.decided', entityType: 'Approval', entityId },
        actorId,
        'tenant-a',
      );

      const expectedFilter = {
        tenantId: 'tenant-a',
        action: 'approvals.decided',
        'subject.entityType': 'Approval',
        'subject.entityId': new Types.ObjectId(entityId),
      };
      expect(mockAuditEventModel.find).toHaveBeenCalledWith(expectedFilter, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockAuditEventModel.countDocuments).toHaveBeenCalledWith(expectedFilter);
    });
  });
});
