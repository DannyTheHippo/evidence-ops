import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { closeTestApp, createTestApp, getTestServer } from '../utils/create-test-app';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('reports mongo up once connected to the in-memory replica set', async () => {
    const response = await request(getTestServer(app)).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', mongo: 'up' });
  });

  it('applies helmet security headers to the response', async () => {
    const response = await request(getTestServer(app)).get('/api/v1/health');

    expect(response.headers['x-dns-prefetch-control']).toBe('off');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  // Must run last in this file: it exhausts the throttler bucket for the /health handler
  // (tracked per-IP for the TTL window), so any request against this route afterwards
  // would itself be rejected with 429 and corrupt the assertions above.
  it('rejects a request burst past the configured throttle limit with 429', async () => {
    /**
     * Sequential, not `Promise.all`: firing the whole burst at once exhausts sockets and fails
     * with ECONNRESET before the throttler is ever consulted. The bucket is per-IP over a TTL
     * window, so serial requests still fill it.
     *
     * Sized from the configured limit rather than hardcoded. Every request here pings Mongo, and
     * the suites run in parallel with one in-memory mongod per worker, so the loop's wall-clock is
     * dominated by that contention — a hardcoded 120 took over 60s under load and timed out. The
     * e2e limit is lowered in `setup-env.ts` precisely so this stays small.
     */
    const throttleLimit = Number(process.env.THROTTLE_LIMIT);
    const burstSize = throttleLimit + 5;
    const server = getTestServer(app);
    const statuses: number[] = [];

    for (let i = 0; i < burstSize; i += 1) {
      statuses.push((await request(server).get('/api/v1/health')).status);
    }

    // Both halves matter: the first request must pass (the guard is not denying wholesale)
    // and a later one must be rejected (the limit is actually enforced).
    expect(statuses[0]).toBe(200);
    expect(statuses).toContain(429);
  });

  // Regression for `trust proxy` defaulting to 0 (`TRUST_PROXY_HOPS`, `app.config.ts`): with no
  // proxy configured, `req.ip` is always the direct socket peer and every `X-Forwarded-For` entry
  // is ignored. Must run immediately after the burst above, whose bucket for this loopback peer is
  // already exhausted — a caller that could mint a fresh bucket by rotating `X-Forwarded-For` would
  // get through here with 200; one that cannot stays blocked with 429.
  it('does not mint a fresh throttle bucket from a spoofed X-Forwarded-For header', async () => {
    const response = await request(getTestServer(app))
      .get('/api/v1/health')
      .set('X-Forwarded-For', `10.0.0.${Math.floor(Math.random() * 254) + 1}`);

    expect(response.status).toBe(429);
  });
});
