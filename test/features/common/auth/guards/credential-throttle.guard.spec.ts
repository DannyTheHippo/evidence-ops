import type { ExecutionContext } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ThrottlerException, ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { EnvironmentConfig } from '../../../../../src/config/environment/environment.config';
import { TypedConfigService } from '../../../../../src/config/environment/typed-config.service';
import { CredentialThrottleGuard } from '../../../../../src/features/common/auth/guards/credential-throttle.guard';
import { AuthenticatedRequest } from '../../../../../src/shared/types/authenticated-request.type';
import { getMockConfig } from '../../../../utils/get-mock-config';
import { getMockTypedConfig } from '../../../../utils/get-mock-typed-config';

const buildContext = (request: Partial<AuthenticatedRequest>): ExecutionContext =>
  ({
    getHandler: () => ({ name: 'login' }),
    getClass: () => ({ name: 'AuthController' }),
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

describe('CredentialThrottleGuard', () => {
  let guard: CredentialThrottleGuard;

  const mockStorage = { increment: jest.fn() };

  const allow = (): void => {
    mockStorage.increment.mockResolvedValue({
      totalHits: 1,
      timeToExpire: 900,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialThrottleGuard,
        { provide: ThrottlerStorage, useValue: mockStorage },
        { provide: TypedConfigService, useValue: getMockTypedConfig() },
      ],
    }).compile();

    guard = module.get(CredentialThrottleGuard);
    allow();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should consume the address and email buckets with their configured limits', async () => {
    const context = buildContext({ ip: '203.0.113.7', body: { email: 'User@Example.com' } });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(mockStorage.increment).toHaveBeenCalledTimes(2);
    expect(mockStorage.increment).toHaveBeenNthCalledWith(
      1,
      'credential-ip:AuthController-login:203.0.113.7',
      900_000,
      10,
      900_000,
      'credential-ip:AuthController-login:203.0.113.7',
    );
    // Lowercased: a case-varied address must not be a fresh allowance. Keyed on the pair, so the
    // allowance one caller spends against an email is theirs alone and not the account's.
    expect(mockStorage.increment).toHaveBeenNthCalledWith(
      2,
      'credential-email:AuthController-login:user%40example.com:203.0.113.7',
      900_000,
      5,
      900_000,
      'credential-email:AuthController-login:user%40example.com:203.0.113.7',
    );
  });

  /**
   * An IPv6 address carries `:`, the same character the key composes its segments with. Encoding
   * the caller-chosen email segment is what stops a crafted email from composing a key that reads
   * as a different (email, address) pair and spending that pair's allowance.
   */
  it('should give a crafted email a different bucket from the pair it imitates', async () => {
    const victim = buildContext({ ip: '203.0.113.7', body: { email: 'victim@example.com' } });
    const forger = buildContext({
      ip: '7',
      body: { email: 'victim@example.com:203.0.113.' },
    });

    await guard.canActivate(victim);
    await guard.canActivate(forger);

    const [victimKey] = mockStorage.increment.mock.calls[1] as [string];
    const [forgedKey] = mockStorage.increment.mock.calls[3] as [string];
    expect(forgedKey).not.toBe(victimKey);
  });

  /**
   * The address dimension fails CLOSED — an unresolvable address is bounded on one shared key,
   * never exempted. The email dimension fails OPEN on the same request: refining a shared
   * pseudo-address by email would produce a bucket spendable against a named account from every
   * unresolvable-address caller at once, which is the lockout the pair keying exists to prevent,
   * and the shared address key already bounds those requests more tightly than the refinement
   * would.
   */
  it('should key an unresolvable address onto a shared bucket, skipping the email dimension', async () => {
    const context = buildContext({ body: { email: 'user@example.com' } });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(mockStorage.increment).toHaveBeenCalledTimes(1);
    expect(mockStorage.increment).toHaveBeenCalledWith(
      'credential-ip:AuthController-login:credential-unresolved',
      900_000,
      10,
      900_000,
      'credential-ip:AuthController-login:credential-unresolved',
    );
  });

  it('should refuse once the address bucket is blocked, without consuming the email bucket', async () => {
    mockStorage.increment.mockResolvedValueOnce({
      totalHits: 11,
      timeToExpire: 900,
      isBlocked: true,
      timeToBlockExpire: 900,
    });
    const context = buildContext({ ip: '203.0.113.7', body: { email: 'user@example.com' } });

    await expect(guard.canActivate(context)).rejects.toThrow(ThrottlerException);
    expect(mockStorage.increment).toHaveBeenCalledTimes(1);
  });

  it('should refuse once the email bucket is blocked', async () => {
    mockStorage.increment
      .mockResolvedValueOnce({
        totalHits: 1,
        timeToExpire: 900,
        isBlocked: false,
        timeToBlockExpire: 0,
      })
      .mockResolvedValueOnce({
        totalHits: 6,
        timeToExpire: 900,
        isBlocked: true,
        timeToBlockExpire: 900,
      });
    const context = buildContext({ ip: '203.0.113.7', body: { email: 'user@example.com' } });

    await expect(guard.canActivate(context)).rejects.toThrow(ThrottlerException);
  });

  /**
   * An invitation redemption carries a token and no email. Collapsing those onto a shared bucket
   * would let one redemption per window deny every other tenant's, so the email dimension is
   * skipped and the address dimension alone bounds them.
   */
  it.each([
    ['a body with no email', { invitationToken: 'a-token' }],
    ['a non-string email', { email: 42 }],
    ['a null body', null],
    ['a non-object body', 'raw-text'],
  ])('should bound %s by address alone', async (_case, body) => {
    const context = buildContext({ ip: '203.0.113.7', body });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(mockStorage.increment).toHaveBeenCalledTimes(1);
    expect(mockStorage.increment).toHaveBeenCalledWith(
      'credential-ip:AuthController-login:203.0.113.7',
      900_000,
      10,
      900_000,
      'credential-ip:AuthController-login:203.0.113.7',
    );
  });
});

describe('CredentialThrottleGuard when the bound storage rejects', () => {
  let guard: CredentialThrottleGuard;
  const mockStorage = { increment: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialThrottleGuard,
        { provide: ThrottlerStorage, useValue: mockStorage },
        { provide: TypedConfigService, useValue: getMockTypedConfig() },
      ],
    }).compile();

    guard = module.get(CredentialThrottleGuard);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  /**
   * Neither dimension catches a storage failure — a rejection propagates out of `canActivate`
   * rather than resolving to an allow. The guard has no fallback path: a broken store takes the
   * credential routes down rather than exempting them from the limit it exists to enforce.
   */
  it.each([
    ['the address dimension', 0],
    ['the email dimension', 1],
  ])(
    'should propagate a storage failure on %s rather than let the request through',
    async (_label, rejectOnCallIndex) => {
      let callIndex = -1;
      mockStorage.increment.mockImplementation(() => {
        callIndex += 1;
        if (callIndex === rejectOnCallIndex) {
          return Promise.reject(new Error('store unavailable'));
        }
        return Promise.resolve({
          totalHits: 1,
          timeToExpire: 900,
          isBlocked: false,
          timeToBlockExpire: 0,
        });
      });
      const context = buildContext({ ip: '203.0.113.40', body: { email: 'user@example.com' } });

      await expect(guard.canActivate(context)).rejects.toThrow('store unavailable');
    },
  );
});

describe('CredentialThrottleGuard against the real ThrottlerStorageService', () => {
  let guard: CredentialThrottleGuard;
  let storage: ThrottlerStorageService;

  const compile = async (auth: Partial<EnvironmentConfig['auth']> = {}): Promise<void> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialThrottleGuard,
        ThrottlerStorageService,
        { provide: ThrottlerStorage, useExisting: ThrottlerStorageService },
        {
          provide: TypedConfigService,
          useValue: getMockTypedConfig({ auth: { ...getMockConfig().auth, ...auth } }),
        },
      ],
    }).compile();

    guard = module.get(CredentialThrottleGuard);
    storage = module.get(ThrottlerStorageService);
  };

  // A key's storage record carries one entry per throttler name it was ever incremented under;
  // this guard only ever uses one name per key, so summing collapses that to the key's real count
  // regardless of which name the guard composes it with.
  const totalHitsFor = (key: string): number => {
    const record = storage.storage.get(key);
    return record ? [...record.totalHits.values()].reduce((sum, hits) => sum + hits, 0) : 0;
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    await compile();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * `ThrottlerStorageService.timeoutIds` (the vendored decay-timer bookkeeping) is keyed by the
   * throttler name passed to `increment`, not by the caller's key — clearing one key's timers on
   * block-reset clears every key sharing that name. This sweeps the property the guard depends on
   * directly: one key's hit count must decay on its own schedule regardless of another key's block
   * lifecycle.
   */
  it("should decay a bystander key's hit count on its own schedule regardless of another key's block-reset", async () => {
    const attacker = buildContext({ ip: '198.51.100.1', body: {} });
    const bystander = buildContext({ ip: '203.0.113.9', body: {} });
    const attackerKey = 'credential-ip:AuthController-login:198.51.100.1';
    const bystanderKey = 'credential-ip:AuthController-login:203.0.113.9';

    for (let i = 0; i < 11; i += 1) {
      await guard.canActivate(attacker).catch(() => undefined);
    }
    expect(storage.storage.get(attackerKey)?.isBlocked).toBe(true);

    // The bystander's hits land while the attacker is still blocked, well inside the attacker's
    // own decay window, so their decay timers are the last ones scheduled and are still pending
    // when the attacker's block later expires.
    jest.advanceTimersByTime(800_000);
    for (let i = 0; i < 3; i += 1) {
      await guard.canActivate(bystander);
    }
    expect(totalHitsFor(bystanderKey)).toBe(3);

    // Crosses the attacker's block expiry (900_000ms after it was set) without yet reaching the
    // bystander's own decay window (900_000ms after the bystander's hits, i.e. 1_700_000ms).
    jest.advanceTimersByTime(100_002);
    await guard.canActivate(attacker).catch(() => undefined);

    // Past the bystander's own decay window. Decay scoped to the bystander's own key returns this
    // to 0; decay scoped to a name shared with the attacker's key does not, because the reset above
    // already cleared the bystander's pending timers before they could fire.
    jest.advanceTimersByTime(900_000);

    expect(totalHitsFor(bystanderKey)).toBe(0);
  });

  /**
   * `ThrottlerStorageService`'s Map has no delete path on any branch of `increment` — a key
   * survives for the life of the process regardless of its window. This sweeps the growth property
   * directly rather than asserting a size limit that does not exist: one permanent entry per
   * distinct pre-validation email, including a shape `@IsEmail()` would reject downstream.
   */
  it('should mint one permanent storage entry per distinct pre-validation email, surviving past its own window', async () => {
    const address = '203.0.113.20';
    const emails = [
      'short@example.com',
      `${'x'.repeat(2000)}@example.com`,
      'percent:hostile/chars%40here@example.com',
      'ünïcödé-multibyte@example.com',
      'not-an-email',
    ];

    for (const email of emails) {
      await guard.canActivate(buildContext({ ip: address, body: { email } }));
    }

    const emailKeys = (): string[] =>
      [...storage.storage.keys()].filter((key) => key.startsWith('credential-email:'));
    expect(emailKeys()).toHaveLength(emails.length);

    jest.advanceTimersByTime(2_000_000);

    expect(emailKeys()).toHaveLength(emails.length);
  });

  /**
   * The email dimension is meant to refuse a single (email, address) pair sooner than the address
   * dimension would on its own — `credentialEmailLimit < credentialIpLimit`. Neither the guard nor
   * the config schema enforces that ordering, so this sweeps what actually gates the pair across
   * the ordering space: below the address limit the email dimension gates first as intended: at or
   * above it, the address dimension always gates first and the email dimension's own threshold is
   * never reached.
   */
  it.each([
    ['emailLimit below ipLimit', { credentialIpLimit: 10, credentialEmailLimit: 5 }, 6],
    ['emailLimit equal to ipLimit', { credentialIpLimit: 10, credentialEmailLimit: 10 }, 11],
    ['emailLimit above ipLimit', { credentialIpLimit: 10, credentialEmailLimit: 15 }, 11],
  ])(
    'should gate a single (email, address) pair at the request the config implies (%s)',
    async (_label, auth, expectedBlockAtRequest) => {
      await compile(auth);
      const context = buildContext({ ip: '203.0.113.30', body: { email: 'victim@example.com' } });

      let blockedAtRequest = -1;
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        try {
          await guard.canActivate(context);
        } catch {
          blockedAtRequest = attempt;
          break;
        }
      }

      expect(blockedAtRequest).toBe(expectedBlockAtRequest);
    },
  );
});
