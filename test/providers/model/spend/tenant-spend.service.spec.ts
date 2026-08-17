import { getModelToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ModelSpendWindow } from '../../../../src/database/schemas/platform/model-spend-window/model-spend-window.schema';
import { TenantSpendLimitExceededError } from '../../../../src/providers/model/errors/tenant-spend-limit-exceeded.error';
import { TenantSpendService } from '../../../../src/providers/model/spend/tenant-spend.service';
import { AppLogger } from '../../../../src/shared/services/logger/logger.service';
import { getMockLogger } from '../../../utils/get-mock-logger';
import { getMockModel } from '../../../utils/get-mock-model';

describe('TenantSpendService', () => {
  let service: TenantSpendService;

  const mockModelSpendWindowModel = getMockModel();
  const mockLogger = getMockLogger();

  // The UTC-day window that every assertion below expects `getWindowStart` to have derived from
  // the system clock pinned by `jest.setSystemTime`.
  const windowStart = new Date('2026-08-17T00:00:00.000Z');

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantSpendService,
        { provide: getModelToken(ModelSpendWindow.name), useValue: mockModelSpendWindowModel },
        { provide: AppLogger, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<TenantSpendService>(TenantSpendService);

    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-17T15:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();
  });

  describe('reserve', () => {
    it('should permit without touching the model when the ceiling is disabled', async () => {
      const result = await service.reserve('tenant-a', 0.5, 0);

      expect(result).toEqual(windowStart);
      expect(mockModelSpendWindowModel.updateOne).not.toHaveBeenCalled();
      expect(mockModelSpendWindowModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should permit without touching the model when the ceiling is negative', async () => {
      const result = await service.reserve('tenant-a', 0.5, -1);

      expect(result).toEqual(windowStart);
      expect(mockModelSpendWindowModel.updateOne).not.toHaveBeenCalled();
      expect(mockModelSpendWindowModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should idempotently ensure the window exists, then atomically increment reservedUsd within budget, returning the window it keyed', async () => {
      mockModelSpendWindowModel.updateOne.mockResolvedValueOnce({ acknowledged: true });
      mockModelSpendWindowModel.findOneAndUpdate.mockResolvedValueOnce({
        tenantId: 'tenant-a',
        windowStart,
        spentUsd: 1,
        reservedUsd: 2,
      });

      const result = await service.reserve('tenant-a', 0.5, 10);

      expect(result).toEqual(windowStart);
      expect(mockModelSpendWindowModel.updateOne).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', windowStart },
        { $setOnInsert: { spentUsd: 0, reservedUsd: 0 } },
        { upsert: true },
      );
      expect(mockModelSpendWindowModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-a',
          windowStart,
          $expr: { $lte: [{ $add: ['$spentUsd', '$reservedUsd', 0.5] }, 10] },
        },
        { $inc: { reservedUsd: 0.5 } },
        { returnDocument: 'after' },
      );
    });

    it('should throw a TenantSpendLimitExceededError when the conditional increment finds no document within budget', async () => {
      mockModelSpendWindowModel.updateOne.mockResolvedValueOnce({ acknowledged: true });
      mockModelSpendWindowModel.findOneAndUpdate.mockResolvedValueOnce(null);

      const error: unknown = await service.reserve('tenant-a', 5, 10).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TenantSpendLimitExceededError);
      expect((error as Error).message).toBe(
        "Reserving $5.0000 for tenant 'tenant-a' would exceed the $10.0000 daily spend ceiling",
      );
    });
  });

  describe('settle', () => {
    it('should release the reservation and record the actual spend against the windowStart passed in', async () => {
      mockModelSpendWindowModel.updateOne.mockResolvedValueOnce({ acknowledged: true });

      await service.settle('tenant-a', windowStart, 0.5, 0.42);

      expect(mockModelSpendWindowModel.updateOne).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', windowStart },
        { $inc: { reservedUsd: -0.5, spentUsd: 0.42 } },
      );
    });

    it('should settle against the window reserve returned, not the window the current clock is in, when the clock has crossed UTC midnight', async () => {
      mockModelSpendWindowModel.updateOne.mockResolvedValueOnce({ acknowledged: true });
      mockModelSpendWindowModel.findOneAndUpdate.mockResolvedValueOnce({
        tenantId: 'tenant-a',
        windowStart,
        spentUsd: 1,
        reservedUsd: 2,
      });
      const reservedWindowStart = await service.reserve('tenant-a', 0.5, 10);

      jest.setSystemTime(new Date('2026-08-18T00:30:00.000Z'));
      mockModelSpendWindowModel.updateOne.mockResolvedValueOnce({ acknowledged: true });
      await service.settle('tenant-a', reservedWindowStart, 0.5, 0.42);

      expect(mockModelSpendWindowModel.updateOne).toHaveBeenLastCalledWith(
        { tenantId: 'tenant-a', windowStart },
        { $inc: { reservedUsd: -0.5, spentUsd: 0.42 } },
      );
    });
  });

  describe('release', () => {
    it('should release the reservation with no spend recorded, against the windowStart passed in', async () => {
      mockModelSpendWindowModel.updateOne.mockResolvedValueOnce({ acknowledged: true });

      await service.release('tenant-a', windowStart, 0.5);

      expect(mockModelSpendWindowModel.updateOne).toHaveBeenCalledWith(
        { tenantId: 'tenant-a', windowStart },
        { $inc: { reservedUsd: -0.5 } },
      );
    });
  });
});
