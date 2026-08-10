import { getConnectionToken } from '@nestjs/mongoose';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { HealthService } from '../../../../src/features/common/health/health.service';

describe('HealthService', () => {
  let service: HealthService;
  const ping = jest.fn();
  const mockConnection = { db: { admin: () => ({ ping }) } };

  const buildModule = async (connection: unknown): Promise<HealthService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HealthService, { provide: getConnectionToken(), useValue: connection }],
    }).compile();

    return module.get<HealthService>(HealthService);
  };

  beforeEach(async () => {
    ping.mockReset();
    service = await buildModule(mockConnection);
  });

  describe('getHealth', () => {
    it('reports ok/up when the mongo ping succeeds', async () => {
      ping.mockResolvedValueOnce({ ok: 1 });

      await expect(service.getHealth()).resolves.toEqual({ status: 'ok', mongo: 'up' });
    });

    it('reports degraded/down when the mongo ping rejects', async () => {
      ping.mockRejectedValueOnce(new Error('connection refused'));

      await expect(service.getHealth()).resolves.toEqual({ status: 'degraded', mongo: 'down' });
    });

    it('reports degraded/down when the mongo ping does not settle before the timeout', async () => {
      jest.useFakeTimers();
      ping.mockImplementationOnce(() => new Promise(() => {}));

      const result = service.getHealth();
      jest.advanceTimersByTime(2000);

      await expect(result).resolves.toEqual({ status: 'degraded', mongo: 'down' });
      jest.useRealTimers();
    });

    it('reports degraded/down when the connection has no db handle yet', async () => {
      const notYetConnected = await buildModule({ db: undefined });

      await expect(notYetConnected.getHealth()).resolves.toEqual({
        status: 'degraded',
        mongo: 'down',
      });
    });
  });
});
