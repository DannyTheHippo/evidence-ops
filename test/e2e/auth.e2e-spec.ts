import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { User, UserDocument } from '../../src/database/schemas/administration/user/user.schema';
import { UserRole } from '../../src/shared/enums/user-role.enum';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface MeResponseBody {
  id: string;
  email: string;
  role: string;
  createdAt: string;
}

interface AuthTokenResponseBody {
  user: MeResponseBody;
}

interface OpenApiDocument {
  components?: { securitySchemes?: Record<string, unknown> };
}

const sessionCookieFromResponse = (setCookieHeader: string[] | undefined): string => {
  const cookie = setCookieHeader?.find((value) => value.startsWith('eo_session='));
  if (!cookie) {
    throw new Error('sessionCookieFromResponse: no eo_session cookie in Set-Cookie header');
  }
  return cookie.split(';')[0];
};

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let userModel: Model<UserDocument>;

  beforeAll(async () => {
    app = await createTestApp();
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  const credentials = { email: 'auth-e2e@example.com', password: 'correct-horse-battery-staple' };

  it('registers, logs in, and round-trips through /me', async () => {
    const registerResponse = await request(getTestServer(app))
      .post('/api/v1/auth/register')
      .send(credentials);
    const registerBody = registerResponse.body as MeResponseBody;

    expect(registerResponse.status).toBe(201);
    expect(registerBody.email).toBe(credentials.email);
    // Exact-key assertion: the only gate catching a MeResponseDto field missing @Expose().
    expect(Object.keys(registerBody).sort()).toEqual(['id', 'email', 'role', 'createdAt'].sort());

    const loginResponse = await request(getTestServer(app))
      .post('/api/v1/auth/login')
      .send(credentials);
    const loginBody = loginResponse.body as AuthTokenResponseBody;

    expect(loginResponse.status).toBe(200);
    // Exact-key assertion: the only gate catching accessToken re-appearing in the response body.
    expect(Object.keys(loginBody).sort()).toEqual(['user']);
    expect(loginBody.user.email).toBe(credentials.email);
    expect(Object.keys(loginBody.user).sort()).toEqual(['id', 'email', 'role', 'createdAt'].sort());

    const sessionCookie = sessionCookieFromResponse(
      loginResponse.headers['set-cookie'] as unknown as string[] | undefined,
    );
    const meResponse = await request(getTestServer(app))
      .get('/api/v1/auth/me')
      .set('Cookie', sessionCookie);
    const meBody = meResponse.body as MeResponseBody;

    expect(meResponse.status).toBe(200);
    expect(meBody.email).toBe(credentials.email);
    expect(meBody.id).toBe(registerBody.id);
    // A sole registrant provisions and lands as the `admin` of a brand-new tenant.
    expect(meBody.role).toBe('admin');
    expect(Object.keys(meBody).sort()).toEqual(['id', 'email', 'role', 'createdAt'].sort());
  });

  it('provisions a distinct tenant for each registration', async () => {
    const first = await registerTestUser(app, {
      email: 'auth-e2e-tenant-a@example.com',
      password: 'correct-horse-battery-staple',
    });
    const second = await registerTestUser(app, {
      email: 'auth-e2e-tenant-b@example.com',
      password: 'correct-horse-battery-staple',
    });

    expect(first.tenantId).not.toBe(second.tenantId);
  });

  describe('invitation-based registration', () => {
    const password = 'correct-horse-battery-staple';

    it('lands an invited user in the inviting tenant as a Member, who is then refused an admin-only control', async () => {
      const admin = await registerTestUser(app, {
        email: 'invite-flow-admin@example.com',
        password,
      });

      const minted = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', admin.cookie)
        .send({ email: 'invite-flow-member@example.com', role: UserRole.Member });
      const { token } = minted.body as { token: string };

      const registerResponse = await request(getTestServer(app))
        .post('/api/v1/auth/register')
        .send({ password, invitationToken: token });
      const registerBody = registerResponse.body as MeResponseBody;

      expect(registerResponse.status).toBe(201);
      expect(registerBody.email).toBe('invite-flow-member@example.com');
      expect(registerBody.role).toBe('member');

      const persisted = await userModel.findOne({ email: 'invite-flow-member@example.com' });
      expect(persisted?.tenantId).toBe(admin.tenantId);

      const loginResponse = await request(getTestServer(app))
        .post('/api/v1/auth/login')
        .send({ email: 'invite-flow-member@example.com', password });
      const memberCookie = sessionCookieFromResponse(
        loginResponse.headers['set-cookie'] as unknown as string[] | undefined,
      );

      // First refusal this gate has ever produced against a real (non-fixture-demoted) Member —
      // proves the role travelled from the invitation into the session, not just the database row.
      const forbidden = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', memberCookie)
        .send({ email: 'invite-flow-outsider@example.com', role: UserRole.Member });

      expect(forbidden.status).toBe(403);
    });

    it('refuses an unknown invitation token, failing closed rather than provisioning a fresh tenant', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/auth/register')
        .send({ password, invitationToken: 'eo_inv_never-minted-fixture' });

      expect(response.status).toBe(400);
    });

    it('refuses redemption when the invitation email already has an account, leaving that account untouched', async () => {
      const admin = await registerTestUser(app, {
        email: 'invite-conflict-admin@example.com',
        password,
      });

      const minted = await request(getTestServer(app))
        .post('/api/v1/invitations')
        .set('Cookie', admin.cookie)
        .send({ email: 'invite-conflict-target@example.com', role: UserRole.Member });
      const { token } = minted.body as { token: string };

      // The invited email registers on its own, without the token, before the invitation is
      // redeemed — provisions its own fresh tenant and lands as that tenant's admin.
      const independent = await registerTestUser(app, {
        email: 'invite-conflict-target@example.com',
        password: 'a-different-password-entirely',
      });

      const redeemResponse = await request(getTestServer(app))
        .post('/api/v1/auth/register')
        .send({ password, invitationToken: token });

      expect(redeemResponse.status).toBe(400);

      const persisted = await userModel.findOne({ email: 'invite-conflict-target@example.com' });
      expect(persisted?.tenantId).toBe(independent.tenantId);
      expect(persisted?.role).toBe(UserRole.Admin);
    });
  });

  // Proves the global APP_GUARD JwtAuthGuard denies by default: only handlers explicitly
  // marked @PublicRoute() are reachable without a token.
  it('rejects an unauthenticated request to a non-public route', async () => {
    const response = await request(getTestServer(app)).get('/api/v1/auth/me');

    expect(response.status).toBe(401);
  });

  // The session cookie is the only credential path JwtAuthGuard accepts. A valid,
  // correctly-signed JWT carried in Authorization instead of the cookie must still 401 — the
  // regression this guards is the header being read as a live credential path again.
  it('rejects a request carrying a valid Bearer token and no session cookie', async () => {
    const { cookie } = await registerTestUser(app, {
      email: 'auth-e2e-bearer-rejected@example.com',
      password: 'correct-horse-battery-staple',
    });
    const token = cookie.slice(cookie.indexOf('=') + 1);

    const response = await request(getTestServer(app))
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
  });

  it('sets an HttpOnly, SameSite=Lax session cookie on login and authenticates subsequent requests with it', async () => {
    const cookieCredentials = {
      email: 'auth-e2e-cookie@example.com',
      password: 'correct-horse-battery-staple',
    };
    await registerTestUser(app, cookieCredentials);

    const loginResponse = await request(getTestServer(app))
      .post('/api/v1/auth/login')
      .send(cookieCredentials);
    const setCookieHeader = loginResponse.headers['set-cookie'] as unknown as string[];
    const sessionCookie = setCookieHeader.find((cookie) => cookie.startsWith('eo_session='));

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/);
    expect(sessionCookie).toMatch(/SameSite=Lax/);

    const cookieValue = sessionCookie?.split(';')[0];
    const meResponse = await request(getTestServer(app))
      .get('/api/v1/auth/me')
      .set('Cookie', cookieValue as string);
    const meBody = meResponse.body as MeResponseBody;

    expect(meResponse.status).toBe(200);
    expect(meBody.email).toBe(cookieCredentials.email);
  });

  // The JWT itself is stateless and stays valid until `exp` — logout only clears the browser's
  // cookie and records the client's intent, it revokes nothing server-side.
  it('clears the session cookie on logout', async () => {
    const logoutCredentials = {
      email: 'auth-e2e-logout@example.com',
      password: 'correct-horse-battery-staple',
    };
    const { cookie } = await registerTestUser(app, logoutCredentials);

    const logoutResponse = await request(getTestServer(app))
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie);
    const setCookieHeader = logoutResponse.headers['set-cookie'] as unknown as string[];
    const clearedCookie = setCookieHeader.find((c) => c.startsWith('eo_session='));

    expect(logoutResponse.status).toBe(204);
    expect(clearedCookie).toBeDefined();
    expect(clearedCookie).toMatch(/Max-Age=0/);
  });

  // Swagger previously advertised `addBearerAuth()`; a reader following that scheme would build a
  // request the guard now rejects. `addCookieAuth` is the only scheme the document should carry.
  it('does not advertise bearer auth in the OpenAPI document', async () => {
    const response = await request(getTestServer(app)).get('/docs-json');
    const body = response.body as OpenApiDocument;

    expect(response.status).toBe(200);
    expect(body.components?.securitySchemes).not.toHaveProperty('bearer');
    expect(body.components?.securitySchemes).toHaveProperty('cookie');
  });

  describe('CsrfOriginMiddleware', () => {
    const email = 'auth-e2e-csrf@example.com';
    const password = 'correct-horse-battery-staple';
    let sessionCookie: string;

    // Registered once and reused across every case below, including the login-route cases (which
    // call /auth/login again but never /auth/register): logout only records an audit entry
    // (auth.service.ts logout) rather than revoking the token, and a repeated login is a
    // stateless JWT issue — neither invalidates or locks the account, so reuse is safe. A fresh
    // registration per case runs bcrypt at cost 12, and the full e2e suite runs files in parallel
    // workers; the added CPU load produced an observed `socket hang up` failure in 1 of 5 full
    // runs.
    beforeAll(async () => {
      const result = await registerTestUser(app, { email, password });
      sessionCookie = result.cookie;
    });

    // The rule is unconditional — see csrf-origin.middleware.ts — so it applies regardless of
    // credential path; the session cookie is the only one that exists.
    it('rejects a cookie-authenticated mutating request carrying a hostile Origin', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/auth/logout')
        .set('Cookie', sessionCookie)
        .set('Origin', 'https://hostile.example.com');

      expect(response.status).toBe(403);
    });

    // Pins the documented fail-open: a non-browser client that omits Origin is not rejected, so
    // a future change to that behavior is a visible test edit rather than a silent regression.
    it('passes a cookie-authenticated mutating request that carries no Origin header', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/auth/logout')
        .set('Cookie', sessionCookie);

      expect(response.status).toBe(204);
    });

    // Login-CSRF hole: /auth/login is @PublicRoute() and its side effect *sets* the session
    // cookie, so a forced cross-site top-level form navigation to it has no cookie yet. The rule
    // is unconditional now (no cookie check, no path allowlist), so login is covered by the same
    // check as every other mutating route — see csrf-origin.middleware.ts.
    describe('the login route', () => {
      it('rejects a cross-origin login carrying a hostile Origin and no session cookie', async () => {
        const response = await request(getTestServer(app))
          .post('/api/v1/auth/login')
          .set('Origin', 'https://hostile.example.com')
          .send({ email, password });

        expect(response.status).toBe(403);
      });

      it('passes a login request with no Origin header, matching the documented fail-open for non-browser clients', async () => {
        const response = await request(getTestServer(app))
          .post('/api/v1/auth/login')
          .send({ email, password });

        expect(response.status).toBe(200);
      });

      // 'http://localhost:5173' is pinned in setup-env.ts so a local `.env` cannot change it.
      it('passes a login request whose Origin matches the configured origin', async () => {
        const response = await request(getTestServer(app))
          .post('/api/v1/auth/login')
          .set('Origin', 'http://localhost:5173')
          .send({ email, password });

        expect(response.status).toBe(200);
      });

      // Bypass regression: the prior middleware matched an exact-string Set against
      // `req.originalUrl.split('?')[0]`. Nest's underlying express() runs with `strict: false`
      // and `caseSensitive: false` (measured on express 5.2.1), so a trailing slash or a case
      // change reached this handler while matching nothing in that Set, taking the
      // cookie-absent fail-open path unconditionally. The new rule has no path check at all, so
      // both variants are covered automatically — asserted here so a future reintroduction of
      // path matching reds this test.
      it('rejects a cross-origin login with a trailing slash in the path', async () => {
        const response = await request(getTestServer(app))
          .post('/api/v1/auth/login/')
          .set('Origin', 'https://hostile.example.com')
          .send({ email, password });

        expect(response.status).toBe(403);
      });

      it('rejects a cross-origin login with the path cased differently', async () => {
        const response = await request(getTestServer(app))
          .post('/api/v1/auth/LOGIN')
          .set('Origin', 'https://hostile.example.com')
          .send({ email, password });

        expect(response.status).toBe(403);
      });
    });
  });
});
