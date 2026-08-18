import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../../../src/shared/guards/user-throttler.guard';
import { UserRole } from '../../../src/shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../src/shared/types/authenticated-request.type';

// `getTracker` is `protected`; this narrows the guard to the one method under test rather than
// reaching for `any`.
type Trackable = { getTracker: (req: Record<string, unknown>) => Promise<string> };

describe('UserThrottlerGuard', () => {
  let guard: UserThrottlerGuard;

  beforeEach(() => {
    const options: ThrottlerModuleOptions = { throttlers: [] };
    const storage: ThrottlerStorage = { increment: jest.fn() };
    guard = new UserThrottlerGuard(options, storage, new Reflector());
  });

  const getTracker = (request: Partial<AuthenticatedRequest>): Promise<string> =>
    (guard as unknown as Trackable).getTracker(request as Record<string, unknown>);

  it('should key by the authenticated user id when request.user is present', async () => {
    const tracker = await getTracker({
      user: {
        userId: 'user-1',
        email: 'a@example.com',
        tenantId: 'tenant-1',
        role: UserRole.Member,
      },
      ip: '203.0.113.7',
    });

    expect(tracker).toBe('user:user-1');
  });

  it('should key by the client IP when request.user is absent', async () => {
    const tracker = await getTracker({ ip: '203.0.113.7' });

    expect(tracker).toBe('ip:203.0.113.7');
  });

  // Fail-closed regression: neither identity resolves, so every such request must still collapse
  // onto one shared tracker rather than being exempted by a unique or empty key.
  it('should fail CLOSED to a shared tracker when neither a user id nor an IP is resolvable', async () => {
    const tracker = await getTracker({});

    expect(tracker).toBe('unresolved');
  });
});
