import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Verification } from '../../../../src/database/schemas/evidence/verification/verification.schema';
import { VerificationNotFoundException } from '../../../../src/features/evidence/verifications/exceptions/verifications.exception';
import { VerificationsService } from '../../../../src/features/evidence/verifications/verifications.service';
import { AuditService } from '../../../../src/shared/services/audit/audit.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('VerificationsService', () => {
  let service: VerificationsService;
  const mockVerificationModel = getMockModel();
  const mockAuditService = { record: jest.fn() };
  const mockLogger = getMockLogger();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationsService,
        { provide: getModelToken(Verification.name), useValue: mockVerificationModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<VerificationsService>(VerificationsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('record', () => {
    it('should pass the whole input to create and return the stringified id', async () => {
      const verificationId = new Types.ObjectId();
      const usage = { promptTokens: 640, completionTokens: 120, costUsd: 0.0031 };
      const results = [{ claimIndex: 0, verdict: 'grounded' as const }];
      const atoms = [{ claimIndex: 0, statement: 'The cap rate is 6.10%.', atoms: ['6.10%'] }];
      mockVerificationModel.create.mockResolvedValueOnce({ _id: verificationId });

      const result = await service.record({
        tenantId: 'tenant-a',
        requestedBy: { kind: 'pat', id: 'pat-1' },
        claims: ['The cap rate is 6.10%.'],
        results,
        advisory: 'advisory text',
        retrievedChunkIds: ['chunk-1'],
        atoms,
        usage,
      });

      expect(mockVerificationModel.create).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        requestedBy: { kind: 'pat', id: 'pat-1' },
        claims: ['The cap rate is 6.10%.'],
        results,
        advisory: 'advisory text',
        retrievedChunkIds: ['chunk-1'],
        atoms,
        usage,
      });
      expect(result).toEqual({ id: verificationId.toString() });
    });
  });

  describe('list', () => {
    const buildVerificationDoc = (overrides: Record<string, unknown> = {}) => ({
      _id: new Types.ObjectId(),
      requestedBy: { kind: 'pat', id: 'pat-1' },
      claims: ['The cap rate is 6.10%.'],
      results: [{ claimIndex: 0, verdict: 'grounded' }],
      advisory: 'advisory text',
      retrievedChunkIds: ['chunk-1'],
      atoms: [],
      usage: { promptTokens: 640, completionTokens: 120, costUsd: 0.0031 },
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      ...overrides,
    });

    it('should list verifications for a tenant with no filter, newest first', async () => {
      const verification = buildVerificationDoc();
      mockVerificationModel.find.mockResolvedValueOnce([verification]);
      mockVerificationModel.countDocuments.mockResolvedValueOnce(1);

      const result = await service.list({ skip: 0, limit: 20 }, 'tenant-a');

      expect(mockVerificationModel.find).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockVerificationModel.countDocuments).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
      expect(mockAuditService.record).not.toHaveBeenCalled();
      expect(result).toEqual({
        docs: [
          {
            id: verification._id.toString(),
            requestedBy: verification.requestedBy,
            claims: verification.claims,
            results: verification.results,
            advisory: verification.advisory,
            retrievedChunkIds: verification.retrievedChunkIds,
            atoms: verification.atoms,
            usage: verification.usage,
            createdAt: verification.createdAt,
          },
        ],
        count: 1,
      });
    });

    it('should add a requestedBy.kind predicate when requestedByKind is provided', async () => {
      mockVerificationModel.find.mockResolvedValueOnce([]);
      mockVerificationModel.countDocuments.mockResolvedValueOnce(0);

      await service.list({ skip: 0, limit: 20, requestedByKind: 'user' }, 'tenant-a');

      const expectedFilter = { tenantId: 'tenant-a', 'requestedBy.kind': 'user' };
      expect(mockVerificationModel.find).toHaveBeenCalledWith(expectedFilter, null, {
        sort: { createdAt: -1 },
        skip: 0,
        limit: 20,
      });
      expect(mockVerificationModel.countDocuments).toHaveBeenCalledWith(expectedFilter);
    });

    it('should resolve a caller-supplied sort direction into the Mongoose sort option', async () => {
      mockVerificationModel.find.mockResolvedValueOnce([]);
      mockVerificationModel.countDocuments.mockResolvedValueOnce(0);

      await service.list({ skip: 0, limit: 20, sort: 'createdAt', sortDir: 'asc' }, 'tenant-a');

      expect(mockVerificationModel.find).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, null, {
        sort: { createdAt: 1 },
        skip: 0,
        limit: 20,
      });
    });
  });

  describe('getById', () => {
    it('should throw VerificationNotFoundException for a syntactically invalid id and never call findOne', async () => {
      await expect(service.getById('not-an-object-id', 'actor', 'tenant-a')).rejects.toBeInstanceOf(
        VerificationNotFoundException,
      );
      expect(mockVerificationModel.findOne).not.toHaveBeenCalled();
      expect(mockVerificationModel.findById).not.toHaveBeenCalled();
    });

    it('should throw VerificationNotFoundException when no row exists for a valid id, never calling findById', async () => {
      const id = new Types.ObjectId().toString();
      mockVerificationModel.findOne.mockResolvedValueOnce(null);

      await expect(service.getById(id, 'actor', 'tenant-a')).rejects.toBeInstanceOf(
        VerificationNotFoundException,
      );
      expect(mockVerificationModel.findOne).toHaveBeenCalledWith({ _id: id, tenantId: 'tenant-a' });
      expect(mockVerificationModel.findById).not.toHaveBeenCalled();
    });

    it("should throw VerificationNotFoundException for another tenant's row", async () => {
      const id = new Types.ObjectId().toString();
      // The mock model does not filter by predicate — the not-found outcome here asserts that
      // `getById` queries with the tenant predicate at all, matching `QaService.peekAnswer`'s spec.
      mockVerificationModel.findOne.mockResolvedValueOnce(null);

      await expect(service.getById(id, 'actor', 'tenant-b')).rejects.toBeInstanceOf(
        VerificationNotFoundException,
      );
      expect(mockVerificationModel.findOne).toHaveBeenCalledWith({ _id: id, tenantId: 'tenant-b' });
    });

    it('should return the verification and record an audit event on a hit', async () => {
      const verificationId = new Types.ObjectId();
      const verification = {
        _id: verificationId,
        requestedBy: { kind: 'pat', id: 'pat-1' },
        claims: ['The cap rate is 6.10%.'],
        results: [{ claimIndex: 0, verdict: 'grounded' }],
        advisory: 'advisory text',
        retrievedChunkIds: ['chunk-1'],
        atoms: [],
        usage: { promptTokens: 640, completionTokens: 120, costUsd: 0.0031 },
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      mockVerificationModel.findOne.mockResolvedValueOnce(verification);
      mockAuditService.record.mockResolvedValueOnce(undefined);

      const result = await service.getById(verificationId.toString(), 'actor-1', 'tenant-a');

      expect(mockAuditService.record).toHaveBeenCalledWith({
        action: 'verifications.verification.viewed',
        actorId: 'actor-1',
        subject: { entityType: 'Verification', entityId: verificationId.toString() },
        tenantId: 'tenant-a',
      });
      expect(result).toEqual({
        id: verificationId.toString(),
        requestedBy: verification.requestedBy,
        claims: verification.claims,
        results: verification.results,
        advisory: verification.advisory,
        retrievedChunkIds: verification.retrievedChunkIds,
        atoms: verification.atoms,
        usage: verification.usage,
        createdAt: verification.createdAt,
      });
    });
  });
});
