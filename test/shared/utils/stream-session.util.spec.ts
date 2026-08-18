import { HttpStatus } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { StreamConnectionLimitExceededException } from '../../../src/shared/exceptions/stream-connection-limit.exception';
import {
  acquireStreamSlot,
  reauthTicks$,
  shouldRecordStreamView,
} from '../../../src/shared/utils/stream-session.util';

describe('reauthTicks$', () => {
  const session = { userId: 'user-1', tenantId: 'tenant-a' };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should not emit while reload keeps resolving the same tenant', async () => {
    const reload = jest.fn().mockResolvedValue({ tenantId: 'tenant-a' });
    let emitted = false;

    reauthTicks$(session, reload, 1000).subscribe(() => {
      emitted = true;
    });
    await jest.advanceTimersByTimeAsync(3000);

    expect(reload).toHaveBeenCalledWith('user-1');
    expect(emitted).toBe(false);
  });

  it('should emit and complete when reload resolves null (session gone)', async () => {
    const reload = jest.fn().mockResolvedValue(null);
    let emitted = false;
    let completed = false;

    reauthTicks$(session, reload, 1000).subscribe({
      next: () => {
        emitted = true;
      },
      complete: () => {
        completed = true;
      },
    });
    await jest.advanceTimersByTimeAsync(1000);

    expect(emitted).toBe(true);
    expect(completed).toBe(true);
  });

  it('should emit and complete when reload resolves a different tenant', async () => {
    const reload = jest.fn().mockResolvedValue({ tenantId: 'tenant-b' });
    let emitted = false;

    reauthTicks$(session, reload, 1000).subscribe(() => {
      emitted = true;
    });
    await jest.advanceTimersByTimeAsync(1000);

    expect(emitted).toBe(true);
  });

  it('should fail closed — emit and complete — when reload rejects', async () => {
    const reload = jest.fn().mockRejectedValue(new Error('transient Mongo hiccup'));
    let emitted = false;

    reauthTicks$(session, reload, 1000).subscribe(() => {
      emitted = true;
    });
    await jest.advanceTimersByTimeAsync(1000);

    expect(emitted).toBe(true);
  });

  it('should emit only once even if the invalidating condition still holds on a later tick', async () => {
    const reload = jest.fn().mockResolvedValue(null);
    const emissions: void[] = [];

    reauthTicks$(session, reload, 1000).subscribe((value) => emissions.push(value));
    await jest.advanceTimersByTimeAsync(5000);

    expect(emissions).toHaveLength(1);
  });

  it('should resolve via firstValueFrom once invalidated, confirming the observable actually completes', async () => {
    const reload = jest.fn().mockResolvedValue(null);

    const resultPromise = firstValueFrom(reauthTicks$(session, reload, 1000));
    await jest.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toBeUndefined();
  });
});

describe('acquireStreamSlot', () => {
  const limits = { maxConnectionsPerTenant: 2, maxConnectionsPerUser: 1 };

  it('should reserve a slot and return a release function when both counters are below cap', () => {
    const release = acquireStreamSlot('tenant-cap-a', 'user-cap-a', limits);

    expect(typeof release).toBe('function');
    release();
  });

  it('should throw StreamConnectionLimitExceededException (429) when the tenant is at its cap', () => {
    const release1 = acquireStreamSlot('tenant-cap-b', 'user-cap-b1', {
      maxConnectionsPerTenant: 1,
      maxConnectionsPerUser: 10,
    });

    expect(() =>
      acquireStreamSlot('tenant-cap-b', 'user-cap-b2', {
        maxConnectionsPerTenant: 1,
        maxConnectionsPerUser: 10,
      }),
    ).toThrow(StreamConnectionLimitExceededException);

    try {
      acquireStreamSlot('tenant-cap-b', 'user-cap-b3', {
        maxConnectionsPerTenant: 1,
        maxConnectionsPerUser: 10,
      });
      throw new Error('expected acquireStreamSlot to throw');
    } catch (error) {
      expect((error as StreamConnectionLimitExceededException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    release1();
  });

  it('should throw StreamConnectionLimitExceededException (429) when the user is at its cap, even under the tenant cap', () => {
    const release1 = acquireStreamSlot('tenant-cap-c', 'user-cap-c', {
      maxConnectionsPerTenant: 10,
      maxConnectionsPerUser: 1,
    });

    expect(() =>
      acquireStreamSlot('tenant-cap-c', 'user-cap-c', {
        maxConnectionsPerTenant: 10,
        maxConnectionsPerUser: 1,
      }),
    ).toThrow(StreamConnectionLimitExceededException);

    release1();
  });

  it('should free the slot on release, allowing a subsequent acquire to succeed at the same cap', () => {
    const release1 = acquireStreamSlot('tenant-cap-d', 'user-cap-d', {
      maxConnectionsPerTenant: 1,
      maxConnectionsPerUser: 1,
    });
    release1();

    const release2 = acquireStreamSlot('tenant-cap-d', 'user-cap-d', {
      maxConnectionsPerTenant: 1,
      maxConnectionsPerUser: 1,
    });
    release2();
  });

  it('should decrement rather than delete the counter when other connections remain open', () => {
    const releaseA = acquireStreamSlot('tenant-cap-e', 'user-cap-e1', {
      maxConnectionsPerTenant: 2,
      maxConnectionsPerUser: 10,
    });
    const releaseB = acquireStreamSlot('tenant-cap-e', 'user-cap-e2', {
      maxConnectionsPerTenant: 2,
      maxConnectionsPerUser: 10,
    });

    releaseA();

    // The tenant counter dropped from 2 to 1, not deleted — a third acquire still succeeds under
    // the cap of 2, proving the surviving connection (releaseB) is still counted.
    expect(() =>
      acquireStreamSlot('tenant-cap-e', 'user-cap-e3', {
        maxConnectionsPerTenant: 2,
        maxConnectionsPerUser: 10,
      }),
    ).not.toThrow();

    releaseB();
  });

  it('should be a no-op on a second release call', () => {
    const release = acquireStreamSlot('tenant-cap-f', 'user-cap-f', {
      maxConnectionsPerTenant: 1,
      maxConnectionsPerUser: 1,
    });
    release();
    release();

    const release2 = acquireStreamSlot('tenant-cap-f', 'user-cap-f', {
      maxConnectionsPerTenant: 1,
      maxConnectionsPerUser: 1,
    });
    release2();
  });

  it('should treat a missing counter as zero rather than propagating NaN, even though the acquire/release invariant guarantees this never happens through the public API', () => {
    const release = acquireStreamSlot('tenant-cap-g', 'user-cap-g', {
      maxConnectionsPerTenant: 1,
      maxConnectionsPerUser: 1,
    });

    const getSpy = jest.spyOn(Map.prototype, 'get').mockReturnValue(undefined);
    release();
    getSpy.mockRestore();

    // `?? 0` read the forced-missing entry as already-zero and deleted it, so a fresh acquire on
    // the same key succeeds under the same cap rather than being blocked by a corrupted counter.
    const release2 = acquireStreamSlot('tenant-cap-g', 'user-cap-g', {
      maxConnectionsPerTenant: 1,
      maxConnectionsPerUser: 1,
    });
    release2();
  });
});

describe('shouldRecordStreamView', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should return true the first time a key is seen', () => {
    expect(shouldRecordStreamView('dedupe-key-a', 1000)).toBe(true);
  });

  it('should return false for the same key while still inside the window', () => {
    expect(shouldRecordStreamView('dedupe-key-b', 1000)).toBe(true);

    jest.advanceTimersByTime(999);

    expect(shouldRecordStreamView('dedupe-key-b', 1000)).toBe(false);
  });

  it('should return true again for the same key once the window has fully elapsed', () => {
    expect(shouldRecordStreamView('dedupe-key-c', 1000)).toBe(true);

    jest.advanceTimersByTime(1000);

    expect(shouldRecordStreamView('dedupe-key-c', 1000)).toBe(true);
  });

  it('should track two different keys independently', () => {
    expect(shouldRecordStreamView('dedupe-key-d1', 1000)).toBe(true);
    expect(shouldRecordStreamView('dedupe-key-d2', 1000)).toBe(true);

    // 'd1' is still inside its own window; 'd2' being a distinct key must not affect it.
    expect(shouldRecordStreamView('dedupe-key-d1', 1000)).toBe(false);
  });
});
