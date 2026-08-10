import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';

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
    const body: unknown = response.body;

    expect(response.status).toBe(201);
    expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
  });

  it('never exposes the password or its hash in the login response, including the nested user', async () => {
    const response = await request(getTestServer(app)).post('/api/v1/auth/login').send(credentials);
    const body: unknown = response.body;

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
  });
});
