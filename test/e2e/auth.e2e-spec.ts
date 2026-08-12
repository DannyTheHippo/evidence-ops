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
});
