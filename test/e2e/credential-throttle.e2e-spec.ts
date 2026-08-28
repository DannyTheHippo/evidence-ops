import type { INestApplication } from '@nestjs/common';
import type { Application } from 'express';
import request from 'supertest';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

/**
 * Own file, own app instance: `CredentialThrottleGuard`'s buckets live in the app's
 * `ThrottlerStorage`, so a burst run inside a suite that also registers fixtures would be counting
 * those fixtures too. It is also a return-type contract the other auth cases do not cover — a 429
 * from the credential routes.
 *
 * `AUTH_CREDENTIAL_EMAIL_LIMIT` is not overridden for e2e (`setup-env.ts`), so these cases run
 * against the number a deployment runs.
 */
describe('Credential throttling (e2e)', () => {
  let app: INestApplication;

  // Mirrors the production default in `environment.config.ts`. Asserted below rather than read
  // from config: a test that reads the same value the guard reads cannot notice the two drifting.
  const EMAIL_LIMIT = 5;
  const password = 'correct-horse-battery-staple';

  /**
   * Supertest reaches the app over one loopback socket, so the only way to give a case a source
   * address of its own is to let `X-Forwarded-For` decide it. Trusting one proxy hop is the shape a
   * deployment behind a single reverse proxy runs (`TRUST_PROXY_HOPS`), and it is applied here
   * rather than in `setup-env.ts` so no other suite's `request.ip` changes. Cases that send no
   * header still resolve to the loopback socket address.
   */
  beforeAll(async () => {
    app = await createTestApp();
    (app.getHttpAdapter().getInstance() as Application).set('trust proxy', 1);
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  const attemptLogin = (email: string) =>
    request(getTestServer(app)).post('/api/v1/auth/login').send({ email, password: 'wrong-guess' });

  /** Spends the email's whole allowance, then returns the response to the attempt past it. */
  const exhaustAllowance = async (email: string, alreadySpent = 0) => {
    for (let attempt = alreadySpent; attempt < EMAIL_LIMIT; attempt += 1) {
      const response = await attemptLogin(email);
      expect(response.status).toBe(401);
    }
    return attemptLogin(email);
  };

  it('refuses further attempts against an email once its allowance is spent', async () => {
    const refused = await exhaustAllowance('throttle-unknown@example.com');

    expect(refused.status).toBe(429);
  });

  /**
   * The account-existence oracle this guard must not become. A backoff that only applies to real
   * accounts, or that answers differently for one, tells an attacker which addresses are worth
   * attacking — so the refusal for an address with an account behind it has to be
   * indistinguishable from the refusal for one without.
   */
  it('refuses a registered email identically to an unregistered one', async () => {
    // Registration itself spends nothing from the login bucket — the two routes are keyed
    // separately — but the successful login inside the helper spends one attempt.
    await registerTestUser(app, { email: 'throttle-known@example.com', password });

    const refusedKnown = await exhaustAllowance('throttle-known@example.com', 1);
    const refusedUnknown = await exhaustAllowance('throttle-oracle-probe@example.com');

    expect(refusedKnown.status).toBe(429);
    expect(refusedUnknown.status).toBe(refusedKnown.status);
    expect(refusedUnknown.body).toEqual(refusedKnown.body as unknown);
  });

  /**
   * The bucket is the address, not the request: a stuffing run rotating passwords against one
   * account must not be able to spend past the ceiling by varying anything else it controls.
   */
  it('counts attempts against one email regardless of how the address is cased', async () => {
    const email = 'throttle-cased@example.com';
    for (let attempt = 0; attempt < EMAIL_LIMIT; attempt += 1) {
      const response = await attemptLogin(attempt % 2 === 0 ? email : email.toUpperCase());
      expect(response.status).toBe(401);
    }

    const refused = await attemptLogin(email);

    expect(refused.status).toBe(429);
  });

  /**
   * The sweep the per-email dimension has to survive: every combination of the four axes a login's
   * outcome can turn on — whether the target email has an account, whether the presented password
   * is the account's, whether the failed attempts ahead of it arrived from one source address or a
   * rotating pool, and whether the final attempt comes from an address that spent that allowance or
   * a fresh one.
   *
   * Two properties are asserted across the whole matrix rather than in one cell. A correct
   * credential authenticates in every cell whose own address has allowance left, so no attempt from
   * anywhere else can deny the account holder. Guessing stays bounded: no incorrect credential ever
   * authenticates, and an address that has spent an email's allowance is refused before the handler
   * runs. Every refusal body is asserted identical to every other refusal body with the same status,
   * so an unregistered email cannot be told from a registered one at any point in the matrix.
   *
   * Each cell runs on its own email and its own addresses, so no cell can spend another's
   * allowance.
   */
  describe('actor and outcome sweep', () => {
    type EmailKind = 'known' | 'unknown';
    type CredentialKind = 'correct' | 'incorrect';
    type SprayShape = 'rotating' | 'same';
    type ActorAddress = 'fresh' | 'reused';

    interface SweepCell {
      readonly email: EmailKind;
      readonly credential: CredentialKind;
      readonly spray: SprayShape;
      readonly actor: ActorAddress;
      readonly expected: number;
    }

    const wrongPassword = 'wrong-guess';

    // On an `unknown` email `correct` names the password the account would have if it existed —
    // there is no account, so it can only be refused, and refused identically to a wrong one.
    const cells: readonly SweepCell[] = [
      { email: 'known', credential: 'correct', spray: 'rotating', actor: 'fresh', expected: 200 },
      { email: 'known', credential: 'correct', spray: 'rotating', actor: 'reused', expected: 200 },
      { email: 'known', credential: 'correct', spray: 'same', actor: 'fresh', expected: 200 },
      { email: 'known', credential: 'correct', spray: 'same', actor: 'reused', expected: 429 },
      { email: 'known', credential: 'incorrect', spray: 'rotating', actor: 'fresh', expected: 401 },
      {
        email: 'known',
        credential: 'incorrect',
        spray: 'rotating',
        actor: 'reused',
        expected: 401,
      },
      { email: 'known', credential: 'incorrect', spray: 'same', actor: 'fresh', expected: 401 },
      { email: 'known', credential: 'incorrect', spray: 'same', actor: 'reused', expected: 429 },
      { email: 'unknown', credential: 'correct', spray: 'rotating', actor: 'fresh', expected: 401 },
      {
        email: 'unknown',
        credential: 'correct',
        spray: 'rotating',
        actor: 'reused',
        expected: 401,
      },
      { email: 'unknown', credential: 'correct', spray: 'same', actor: 'fresh', expected: 401 },
      { email: 'unknown', credential: 'correct', spray: 'same', actor: 'reused', expected: 429 },
      {
        email: 'unknown',
        credential: 'incorrect',
        spray: 'rotating',
        actor: 'fresh',
        expected: 401,
      },
      {
        email: 'unknown',
        credential: 'incorrect',
        spray: 'rotating',
        actor: 'reused',
        expected: 401,
      },
      { email: 'unknown', credential: 'incorrect', spray: 'same', actor: 'fresh', expected: 401 },
      { email: 'unknown', credential: 'incorrect', spray: 'same', actor: 'reused', expected: 429 },
    ];

    // First body seen per refusal status becomes the reference every later refusal is compared
    // against, in whatever order jest runs the cells.
    const refusalBodies = new Map<number, unknown>();

    const login = (email: string, password: string, address: string) =>
      request(getTestServer(app))
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', address)
        .send({ email, password });

    const registerAt = (email: string, address: string) =>
      request(getTestServer(app))
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', address)
        .send({ email, password });

    /**
     * The four cells sharing an email kind and a spray shape share the run that spends the
     * allowance, because that prelude is the expensive half — each attempt is a bcrypt at cost 12,
     * and this suite runs alongside every other e2e file. Sharing is sound because the cells differ
     * only in what the final attempt carries and where it comes from: each `fresh` cell gets an
     * address of its own, and the `reused` cells reuse the prelude's last address, whose allowance is
     * already in the state the cell is about.
     */
    const groups = [
      { email: 'known' as EmailKind, spray: 'rotating' as SprayShape },
      { email: 'known' as EmailKind, spray: 'same' as SprayShape },
      { email: 'unknown' as EmailKind, spray: 'rotating' as SprayShape },
      { email: 'unknown' as EmailKind, spray: 'same' as SprayShape },
    ];

    it('covers every combination of the four axes exactly once', () => {
      const combinations = cells.map(
        (cell) => `${cell.email}/${cell.credential}/${cell.spray}/${cell.actor}`,
      );

      expect(new Set(combinations).size).toBe(combinations.length);
      expect(combinations.length).toBe(16);
      // Every cell reached by exactly one group, so no row of the table goes unrun.
      expect(
        groups.flatMap((group) =>
          cells.filter((cell) => cell.email === group.email && cell.spray === group.spray),
        ),
      ).toHaveLength(cells.length);
    });

    it.each(groups.map((group, index) => [index, group.email, group.spray] as const))(
      'group %i: an allowance spent against a %s email from a %s address',
      async (index, emailKind, spray) => {
        const email = `sweep-${index}@example.com`;
        const sharedAddress = `10.${index}.3.1`;
        const sprayAddresses =
          spray === 'rotating'
            ? Array.from({ length: EMAIL_LIMIT }, (_unused, n) => `10.${index}.2.${n + 1}`)
            : Array.from({ length: EMAIL_LIMIT }, () => sharedAddress);

        if (emailKind === 'known') {
          const registered = await registerAt(email, `10.${index}.1.1`);
          expect(registered.status).toBe(201);
        }

        for (const address of sprayAddresses) {
          const sprayed = await login(email, wrongPassword, address);
          expect(sprayed.status).toBe(401);
        }

        const groupCells = cells.filter((cell) => cell.email === emailKind && cell.spray === spray);
        for (const [ordinal, cell] of groupCells.entries()) {
          const actorAddress =
            cell.actor === 'fresh'
              ? `10.${index}.4.${ordinal + 1}`
              : sprayAddresses[sprayAddresses.length - 1];
          const response = await login(
            email,
            cell.credential === 'correct' ? password : wrongPassword,
            actorAddress,
          );

          // Compared as an object so a failure names the cell rather than only the status.
          expect({ ...cell, status: response.status }).toEqual({ ...cell, status: cell.expected });

          if (cell.expected === 200) {
            continue;
          }
          const reference = refusalBodies.get(cell.expected);
          if (reference === undefined) {
            refusalBodies.set(cell.expected, response.body);
            continue;
          }
          expect(response.body).toEqual(reference);
        }
      },
    );
  });
});
