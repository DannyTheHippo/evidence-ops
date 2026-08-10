import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Types } from 'mongoose';
import { AuditEvent } from '../../../../src/database/schemas/audit/audit-event/audit-event.schema';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('AuditService', () => {
  let service: AuditService;
  const mockAuditEventModel = getMockModel();
  const mockAls = { getStore: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getModelToken(AuditEvent.name), useValue: mockAuditEventModel },
        { provide: AsyncLocalStorage, useValue: mockAls },
        { provide: AppLogger, useValue: getMockLogger() },
      ],
    }).compile();

    service = module.get<AuditService>(AuditService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should record an event using the correlation id from the ALS store and an explicit tenantId', async () => {
    const actorId = new Types.ObjectId().toString();
    const entityId = new Types.ObjectId().toString();
    mockAls.getStore.mockReturnValueOnce({ 'correlation-id': 'test-correlation-id' });
    mockAuditEventModel.create.mockResolvedValueOnce({ _id: new Types.ObjectId() });

    await service.record({
      action: 'qa.question.started',
      actorId,
      subject: { entityType: 'Answer', entityId },
      tenantId: 'acme',
    });

    expect(mockAuditEventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: new Types.ObjectId(actorId),
        action: 'qa.question.started',
        subject: { entityType: 'Answer', entityId: new Types.ObjectId(entityId) },
        correlationId: 'test-correlation-id',
        tenantId: 'acme',
      }),
    );
  });

  it('should default the correlation id and tenantId when the ALS store has neither', async () => {
    const actorId = new Types.ObjectId().toString();
    const entityId = new Types.ObjectId().toString();
    mockAls.getStore.mockReturnValueOnce(undefined);
    mockAuditEventModel.create.mockResolvedValueOnce({ _id: new Types.ObjectId() });

    await service.record({
      action: 'conflicts.listed',
      actorId,
      subject: { entityType: 'User', entityId },
    });

    const createMock = mockAuditEventModel.create as jest.Mock<
      Promise<unknown>,
      [{ correlationId: string; tenantId: string }]
    >;
    const call = createMock.mock.calls[0][0];
    expect(typeof call.correlationId).toBe('string');
    expect(call.correlationId).not.toHaveLength(0);
    expect(call.tenantId).toBe('default');
  });
});
