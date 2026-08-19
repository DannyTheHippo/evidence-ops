import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { SkipThrottle, ThrottlerException } from '@nestjs/throttler';
import { PreAuthThrottlerGuard } from '../../../src/shared/guards/pre-auth-throttler.guard';
import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

// Not exported from `@nestjs/throttler`'s package root (only `ThrottlerStorage` is); the shape
// matches `ThrottlerStorage.increment`'s return type.
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

const buildContext = (request: Partial<{ ip?: string }>): ExecutionContext =>
  ({
    getClass: () => ({ name: 'RetrievalController' }),
    getHandler: () => ({ name: 'search' }),
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const allowedRecord: ThrottlerStorageRecord = {
  totalHits: 1,
  timeToExpire: 60,
  isBlocked: false,
  timeToBlockExpire: 0,
};

const blockedRecord: ThrottlerStorageRecord = {
  totalHits: 101,
  timeToExpire: 60,
  isBlocked: true,
  timeToBlockExpire: 60,
};

describe('PreAuthThrottlerGuard', () => {
  let increment: jest.Mock<
    Promise<ThrottlerStorageRecord>,
    [string, number, number, number, string]
  >;
  let storage: ThrottlerStorage;
  let reflector: Reflector;
  let guard: PreAuthThrottlerGuard;

  beforeEach(() => {
    increment = jest
      .fn<Promise<ThrottlerStorageRecord>, [string, number, number, number, string]>()
      .mockResolvedValue(allowedRecord);
    storage = { increment };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    guard = new PreAuthThrottlerGuard(storage, getMockTypedConfig(), reflector);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should allow the request and key the bucket by caller IP when under the limit', async () => {
    const context = buildContext({ ip: '203.0.113.7' });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    const [key, ttl, limit] = increment.mock.calls[0];
    expect(key).toContain('pre-auth-ip:203.0.113.7');
    expect(ttl).toBe(60000);
    expect(limit).toBe(100);
  });

  it('should throw ThrottlerException once the storage reports the bucket blocked', async () => {
    increment.mockResolvedValue(blockedRecord);
    const context = buildContext({ ip: '203.0.113.7' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ThrottlerException);
  });

  // Fail-closed regression, mirroring `UserThrottlerGuard`: an unresolvable IP still collapses onto
  // one fixed shared key rather than being exempted from the perimeter check entirely.
  it('should fail CLOSED to a shared tracker when no IP is resolvable', async () => {
    const context = buildContext({});

    await guard.canActivate(context);

    const [key] = increment.mock.calls[0];
    expect(key).toContain('pre-auth-unresolved');
  });

  // Scoping regression: two different routes must not share a bucket even from the same caller IP.
  it('should key different routes independently for the same caller IP', async () => {
    await guard.canActivate(buildContext({ ip: '203.0.113.7' }));
    const firstKey = increment.mock.calls[0][0];

    const otherRouteContext = {
      getClass: () => ({ name: 'AuthController' }),
      getHandler: () => ({ name: 'login' }),
      switchToHttp: () => ({ getRequest: () => ({ ip: '203.0.113.7' }) }),
    } as unknown as ExecutionContext;
    await guard.canActivate(otherRouteContext);
    const secondKey = increment.mock.calls[1][0];

    expect(firstKey).not.toBe(secondKey);
  });

  // Regression for the perimeter guard silently ignoring `@SkipThrottle()`: a route carrying the
  // decorator must be let through even once the caller's bucket is already exhausted, the same way
  // `UserThrottlerGuard` (which extends `@nestjs/throttler`'s `ThrottlerGuard` and gets this for
  // free) already behaves.
  it('should let a @SkipThrottle() route through without touching the storage bucket', async () => {
    increment.mockResolvedValue(blockedRecord);
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);
    const context = buildContext({ ip: '203.0.113.7' });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(increment).not.toHaveBeenCalled();
  });

  /**
   * Pins the guard's metadata key to the decorator that actually writes it. `@nestjs/throttler`
   * does not re-export `THROTTLER_SKIP` from its package root, so the guard reconstructs the key
   * as a literal rather than reaching into `dist/` internals — which means a library change to
   * that key would restore the exact bug this guard was fixed for, with every mocked test above
   * still passing. This applies the real decorator through a real `Reflector` so that change
   * fails here instead of in production.
   */
  it('should read the same metadata key that @SkipThrottle() actually writes', async () => {
    @SkipThrottle()
    class SkippedController {
      // `this: void` because the guard only ever reads metadata off this reference — it is never
      // invoked, and the reference is passed detached from its class.
      handler(this: void): void {}
    }

    const realReflector = new Reflector();
    const pinnedGuard = new PreAuthThrottlerGuard(storage, getMockTypedConfig(), realReflector);
    increment.mockResolvedValue(blockedRecord);

    const context = {
      getClass: () => SkippedController,
      getHandler: () => SkippedController.prototype.handler,
      switchToHttp: () => ({ getRequest: () => ({ ip: '203.0.113.9' }) }),
    } as unknown as ExecutionContext;

    await expect(pinnedGuard.canActivate(context)).resolves.toBe(true);
    expect(increment).not.toHaveBeenCalled();
  });
});
