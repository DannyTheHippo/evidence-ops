import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

describe('Serialization (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  const credentials = {
    email: 'serialization-e2e@example.com',
    password: 'correct-horse-battery-staple',
  };

  // Regression test for the `excludeExtraneousValues` fix: only fields declared @Expose on
  // the response DTOs may reach the client, so the raw password/hash can never leak.
  it('never exposes the password or its hash in the register response', async () => {
    const response = await request(getTestServer(app))
      .post('/api/v1/auth/register')
      .send(credentials);
    const body = response.body as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
    // Exact-key assertion: the only gate catching a MeResponseDto field missing @Expose().
    expect(Object.keys(body).sort()).toEqual(['id', 'email', 'role', 'createdAt'].sort());
  });

  it('never exposes the password or its hash in the login response, including the nested user', async () => {
    const response = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentials);
    const body = response.body as { accessToken: string; user: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
    expect(Object.keys(body.user).sort()).toEqual(['id', 'email', 'role', 'createdAt'].sort());
  });

  // Regression for the inventory fields (D8): a response DTO field without @Expose() is dropped
  // silently, with no error anywhere — this is the gate that catches it for the four new Source
  // fields plus the previously write-only-by-accident sourceClass.
  it('exposes every Source inventory field in the create response', async () => {
    const { cookie } = await registerTestUser(app, {
      email: 'serialization-sources-e2e@example.com',
      password: 'correct-horse-battery',
    });

    const response = await request(getTestServer(app))
      .post('/api/v1/sources')
      .set('Cookie', cookie)
      .send({
        name: `Serialization Source ${Date.now()}`,
        kind: 'local-folder',
        path: 'deal-room',
        owner: 'Jane Doe, IT',
        connectivity: 'export-only',
        reachability: 'possible',
        tracked: false,
        sourceClass: 'crm-export',
      });
    const body = response.body as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body.connectivity).toBe('export-only');
    expect(body.reachability).toBe('possible');
    expect(body.owner).toBe('Jane Doe, IT');
    expect(body.tracked).toBe(false);
    expect(body.sourceClass).toBe('crm-export');
  });
});
