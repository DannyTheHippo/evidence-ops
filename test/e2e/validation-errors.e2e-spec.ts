import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';
import { registerTestUser } from '../utils/register-test-user';

interface FieldValidationErrorBody {
  field: string;
  message: string;
}

interface ValidationErrorResponseBody {
  statusCode: number;
  error: string;
  message: string;
  errors?: FieldValidationErrorBody[];
}

describe('Validation errors (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('carries a per-field breakdown alongside a string message for a flat body-DTO failure', async () => {
    const response = await request(getTestServer(app))
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'correct-horse-battery-staple' });
    const body = response.body as ValidationErrorResponseBody;

    expect(response.status).toBe(400);
    expect(typeof body.message).toBe('string');
    expect(body.errors).toContainEqual({
      field: 'email',
      message: 'email must be an email',
    });
  });

  it('produces multiple errors entries sharing the same field when one property fails more than one constraint', async () => {
    const admin = await registerTestUser(app, {
      email: 'validation-e2e-repeated@example.com',
      password: 'correct-horse-battery-staple',
    });

    const response = await request(getTestServer(app))
      .get('/api/v1/retrieval/search')
      .query({ query: 'a search query', skip: 'not-a-number' })
      .set('Cookie', admin.cookie);
    const body = response.body as ValidationErrorResponseBody;

    expect(response.status).toBe(400);
    const skipErrors = body.errors?.filter((error) => error.field === 'skip');
    expect(skipErrors?.length).toBeGreaterThanOrEqual(2);
    expect(skipErrors).toContainEqual({ field: 'skip', message: expect.any(String) as string });
  });

  it('carries errors for a query-DTO failure', async () => {
    const admin = await registerTestUser(app, {
      email: 'validation-e2e-query@example.com',
      password: 'correct-horse-battery-staple',
    });

    const response = await request(getTestServer(app))
      .get('/api/v1/retrieval/search')
      .query({ query: '' })
      .set('Cookie', admin.cookie);
    const body = response.body as ValidationErrorResponseBody;

    expect(response.status).toBe(400);
    expect(body.errors).toContainEqual(
      expect.objectContaining({ field: 'query', message: expect.any(String) as string }),
    );
  });

  it('carries errors for an unknown property rejected by forbidNonWhitelisted', async () => {
    const response = await request(getTestServer(app)).post('/api/v1/auth/register').send({
      email: 'validation-e2e-whitelist@example.com',
      password: 'correct-horse-battery-staple',
      extraField: 'not a real field',
    });
    const body = response.body as ValidationErrorResponseBody;

    expect(response.status).toBe(400);
    expect(body.errors).toContainEqual(
      expect.objectContaining({ field: 'extraField', message: expect.any(String) as string }),
    );
  });

  it('carries no errors key on a domain BaseException 400', async () => {
    const response = await request(getTestServer(app))
      .post('/api/v1/auth/register')
      .send({ password: 'correct-horse-battery-staple', invitationToken: 'eo_inv_never-minted' });
    const body = response.body as ValidationErrorResponseBody;

    expect(response.status).toBe(400);
    expect(body).not.toHaveProperty('errors');
  });
});
