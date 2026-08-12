import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';

interface MeResponseBody {
  id: string;
  email: string;
  role: string;
  createdAt: string;
}

interface AuthTokenResponseBody {
  accessToken: string;
  user: MeResponseBody;
}

describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
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
    expect(typeof loginBody.accessToken).toBe('string');
    expect(loginBody.user.email).toBe(credentials.email);
    expect(Object.keys(loginBody.user).sort()).toEqual(['id', 'email', 'role', 'createdAt'].sort());

    const meResponse = await request(getTestServer(app))
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${loginBody.accessToken}`);
    const meBody = meResponse.body as MeResponseBody;

    expect(meResponse.status).toBe(200);
    expect(meBody.email).toBe(credentials.email);
    expect(meBody.id).toBe(registerBody.id);
    expect(meBody.role).toBe('member');
    expect(Object.keys(meBody).sort()).toEqual(['id', 'email', 'role', 'createdAt'].sort());
  });

  // Proves the global APP_GUARD JwtAuthGuard denies by default: only handlers explicitly
  // marked @PublicRoute() are reachable without a token.
  it('rejects an unauthenticated request to a non-public route', async () => {
    const response = await request(getTestServer(app)).get('/api/v1/auth/me');

    expect(response.status).toBe(401);
  });

  it('sets an HttpOnly, SameSite=Lax session cookie on login and accepts it in place of a Bearer header', async () => {
    const cookieCredentials = {
      email: 'auth-e2e-cookie@example.com',
      password: 'correct-horse-battery-staple',
    };
    await request(getTestServer(app)).post('/api/v1/auth/register').send(cookieCredentials);

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

  // JWT is stateless: logout clears the browser's cookie but cannot revoke the token itself, so
  // this only asserts the cookie is expired client-side, not that the prior Bearer token stopped
  // working.
  it('clears the session cookie on logout', async () => {
    const logoutCredentials = {
      email: 'auth-e2e-logout@example.com',
      password: 'correct-horse-battery-staple',
    };
    await request(getTestServer(app)).post('/api/v1/auth/register').send(logoutCredentials);
    const loginResponse = await request(getTestServer(app))
      .post('/api/v1/auth/login')
      .send(logoutCredentials);
    const loginBody = loginResponse.body as AuthTokenResponseBody;

    const logoutResponse = await request(getTestServer(app))
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${loginBody.accessToken}`);
    const setCookieHeader = logoutResponse.headers['set-cookie'] as unknown as string[];
    const clearedCookie = setCookieHeader.find((cookie) => cookie.startsWith('eo_session='));

    expect(logoutResponse.status).toBe(204);
    expect(clearedCookie).toBeDefined();
    expect(clearedCookie).toMatch(/Max-Age=0/);
  });

  describe('CsrfOriginMiddleware', () => {
    const email = 'auth-e2e-csrf@example.com';
    const password = 'correct-horse-battery-staple';
    let logoutCredentials: { accessToken: string; sessionCookie: string };

    // Registered once and reused across every case below, including the login-route cases (which
    // call /auth/login again but never /auth/register): logout only records an audit entry
    // (auth.service.ts logout) rather than revoking the token, and a repeated login is a
    // stateless JWT issue — neither invalidates or locks the account, so reuse is safe. A fresh
    // registration per case runs bcrypt at cost 12, and the full e2e suite runs files in parallel
    // workers; the added CPU load produced an observed `socket hang up` failure in 1 of 5 full
    // runs.
    beforeAll(async () => {
      await request(getTestServer(app)).post('/api/v1/auth/register').send({ email, password });
      const loginResponse = await request(getTestServer(app))
        .post('/api/v1/auth/login')
        .send({ email, password });
      const loginBody = loginResponse.body as AuthTokenResponseBody;
      const setCookieHeader = loginResponse.headers['set-cookie'] as unknown as string[];
      const sessionCookie = setCookieHeader
        .find((cookie) => cookie.startsWith('eo_session='))
        ?.split(';')[0] as string;

      logoutCredentials = { accessToken: loginBody.accessToken, sessionCookie };
    });

    it('rejects a cookie-authenticated mutating request carrying a hostile Origin', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/auth/logout')
        .set('Cookie', logoutCredentials.sessionCookie)
        .set('Origin', 'https://hostile.example.com');

      expect(response.status).toBe(403);
    });

    it('leaves a Bearer-authenticated mutating request untouched by the same hostile Origin', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${logoutCredentials.accessToken}`)
        .set('Origin', 'https://hostile.example.com');

      expect(response.status).toBe(204);
    });

    // Pins the documented fail-open: a non-browser client that omits Origin is not rejected, so
    // a future change to that behavior is a visible test edit rather than a silent regression.
    it('passes a cookie-authenticated mutating request that carries no Origin header', async () => {
      const response = await request(getTestServer(app))
        .post('/api/v1/auth/logout')
        .set('Cookie', logoutCredentials.sessionCookie);

      expect(response.status).toBe(204);
    });

    // Login-CSRF hole: /auth/login is @PublicRoute() and its side effect *sets* the session
    // cookie, so a forced cross-site top-level form navigation to it has no cookie yet — the
    // general cookie-absent exemption above would otherwise pass it through unconditionally. See
    // csrf-origin.middleware.ts, COOKIE_SETTING_PATHS.
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

      // 'http://localhost:5173' is CORS_ORIGIN's default (environment.config.ts) — setup-env.ts
      // does not override it for the e2e run.
      it('passes a login request whose Origin matches the configured origin', async () => {
        const response = await request(getTestServer(app))
          .post('/api/v1/auth/login')
          .set('Origin', 'http://localhost:5173')
          .send({ email, password });

        expect(response.status).toBe(200);
      });
    });
  });
});
