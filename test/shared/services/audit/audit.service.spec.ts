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
        // A caller that names no origin, in a scope that carries none, is the interactive path.
        origin: 'api',
        tenantId: 'acme',
      }),
    );
  });

  // The MCP surface labels its rows by opening an ALS scope carrying `origin`, so a shared service
  // called from inside a `tools/call` — this is `qa.answer.viewed`'s exact path — records the call
  // as MCP-originated without taking an origin argument of its own.
  it('should take the origin from the ALS store when the caller passes none', async () => {
    const actorId = new Types.ObjectId().toString();
    const entityId = new Types.ObjectId().toString();
    mockAls.getStore.mockReturnValueOnce({ 'correlation-id': 'mcp-correlation-id', origin: 'mcp' });
    mockAuditEventModel.create.mockResolvedValueOnce({ _id: new Types.ObjectId() });

    await service.record({
      action: 'qa.answer.viewed',
      actorId,
      subject: { entityType: 'Answer', entityId },
      tenantId: 'acme',
    });

    expect(mockAuditEventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'qa.answer.viewed', origin: 'mcp' }),
    );
  });

  it('should prefer an explicit origin over the ALS store and carry the MCP tool-call fields', async () => {
    const actorId = new Types.ObjectId().toString();
    mockAls.getStore.mockReturnValueOnce({ 'correlation-id': 'mcp-correlation-id', origin: 'api' });
    mockAuditEventModel.create.mockResolvedValueOnce({ _id: new Types.ObjectId() });

    await service.record({
      action: 'mcp.tool_call.refused',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId: 'acme',
      origin: 'mcp',
      toolName: 'search_evidence',
      refusalReason: 'authz-denied',
    });

    expect(mockAuditEventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp.tool_call.refused',
        origin: 'mcp',
        toolName: 'search_evidence',
        refusalReason: 'authz-denied',
      }),
    );
  });

  it('should default the correlation id when the ALS store is empty', async () => {
    const actorId = new Types.ObjectId().toString();
    const entityId = new Types.ObjectId().toString();
    mockAls.getStore.mockReturnValueOnce(undefined);
    mockAuditEventModel.create.mockResolvedValueOnce({ _id: new Types.ObjectId() });

    await service.record({
      action: 'conflicts.listed',
      actorId,
      subject: { entityType: 'User', entityId },
      tenantId: 'acme',
    });

    const createMock = mockAuditEventModel.create as jest.Mock<
      Promise<unknown>,
      [{ correlationId: string; tenantId: string; origin: string }]
    >;
    const call = createMock.mock.calls[0][0];
    expect(typeof call.correlationId).toBe('string');
    expect(call.correlationId).not.toHaveLength(0);
    expect(call.tenantId).toBe('acme');
    // An absent store resolves the origin the same way a store with no origin does.
    expect(call.origin).toBe('api');
  });
});
