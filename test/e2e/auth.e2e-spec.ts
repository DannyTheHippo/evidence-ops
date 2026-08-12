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
    const registerAndLogin = async (
      email: string,
    ): Promise<{ accessToken: string; sessionCookie: string }> => {
      const password = 'correct-horse-battery-staple';
      await request(getTestServer(app)).post('/api/v1/auth/register').send({ email, password });
      const loginResponse = await request(getTestServer(app))
        .post('/api/v1/auth/login')
        .send({ email, password });
      const loginBody = loginResponse.body as AuthTokenResponseBody;
      const setCookieHeader = loginResponse.headers['set-cookie'] as unknown as string[];
      const sessionCookie = setCookieHeader
        .find((cookie) => cookie.startsWith('eo_session='))
        ?.split(';')[0] as string;

      return { accessToken: loginBody.accessToken, sessionCookie };
    };

    it('rejects a cookie-authenticated mutating request carrying a hostile Origin', async () => {
      const { sessionCookie } = await registerAndLogin('auth-e2e-csrf-cookie@example.com');

      const response = await request(getTestServer(app))
        .post('/api/v1/auth/logout')
        .set('Cookie', sessionCookie)
        .set('Origin', 'https://hostile.example.com');

      expect(response.status).toBe(403);
    });

    it('leaves a Bearer-authenticated mutating request untouched by the same hostile Origin', async () => {
      const { accessToken } = await registerAndLogin('auth-e2e-csrf-bearer@example.com');

      const response = await request(getTestServer(app))
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Origin', 'https://hostile.example.com');

      expect(response.status).toBe(204);
    });

    // Pins the documented fail-open: a non-browser client that omits Origin is not rejected, so
    // a future change to that behavior is a visible test edit rather than a silent regression.
    it('passes a cookie-authenticated mutating request that carries no Origin header', async () => {
      const { sessionCookie } = await registerAndLogin('auth-e2e-csrf-no-origin@example.com');

      const response = await request(getTestServer(app))
        .post('/api/v1/auth/logout')
        .set('Cookie', sessionCookie);

      expect(response.status).toBe(204);
    });
  });
});
