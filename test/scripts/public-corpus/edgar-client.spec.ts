import { EdgarClient, type EdgarClock } from '../../../scripts/public-corpus/lib/edgar-client';

function buildJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.reject(new Error('not called')),
  } as unknown as Response;
}

function buildBytesResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
  } as unknown as Response;
}

function buildFailedResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: `status ${status}`,
    json: () => Promise.reject(new Error('not called')),
    arrayBuffer: () => Promise.reject(new Error('not called')),
  } as unknown as Response;
}

/**
 * An instant, deterministic stand-in for `EdgarClock` — `sleep` resolves immediately but still
 * advances the virtual clock `now()` reads, so pacing/backoff math produces real millisecond
 * values without a test ever waiting in real time. `sleepCalls` records every requested delay.
 */
function createVirtualClock(): EdgarClock & { sleepCalls: number[] } {
  let virtualNow = 0;
  const sleepCalls: number[] = [];
  return {
    now: () => virtualNow,
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      virtualNow += ms;
      return Promise.resolve();
    },
    sleepCalls,
  };
}

describe('EdgarClient', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  let clock: EdgarClock & { sleepCalls: number[] };

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    clock = createVirtualClock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('refuses construction without a User-Agent naming a contact email', () => {
    expect(() => new EdgarClient({ userAgent: '', minIntervalMs: 150 }, clock)).toThrow(
      /User-Agent/,
    );
    expect(
      () => new EdgarClient({ userAgent: 'Evidence Ops benchmark', minIntervalMs: 150 }, clock),
    ).toThrow(/User-Agent/);
  });

  it('sends the configured User-Agent on every request', async () => {
    fetchMock.mockResolvedValue(buildJsonResponse({ ok: true }));
    const client = new EdgarClient(
      { userAgent: 'Evidence Ops benchmark contact@example.com', minIntervalMs: 150 },
      clock,
    );

    await client.fetchJson('https://data.sec.gov/submissions/CIK0000000001.json');

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['User-Agent']).toBe('Evidence Ops benchmark contact@example.com');
  });

  it('never spaces requests closer than the fair-access floor even if minIntervalMs asks for less', async () => {
    fetchMock.mockResolvedValue(buildJsonResponse({ ok: true }));
    // 10ms would allow 100 req/s — far past SEC's 10 req/s cap — so the client must clamp up.
    const client = new EdgarClient(
      { userAgent: 'Bot contact@example.com', minIntervalMs: 10 },
      clock,
    );

    await client.fetchJson('https://data.sec.gov/submissions/CIK0000000001.json');
    await client.fetchJson('https://data.sec.gov/submissions/CIK0000000002.json');

    expect(clock.sleepCalls).toEqual([100]);
  });

  it('spaces request starts at least minIntervalMs apart when it exceeds the floor', async () => {
    fetchMock.mockResolvedValue(buildJsonResponse({ ok: true }));
    const client = new EdgarClient(
      { userAgent: 'Bot contact@example.com', minIntervalMs: 150 },
      clock,
    );

    await client.fetchJson('https://data.sec.gov/submissions/CIK0000000001.json');
    await client.fetchJson('https://data.sec.gov/submissions/CIK0000000002.json');
    await client.fetchJson('https://data.sec.gov/submissions/CIK0000000003.json');

    expect(clock.sleepCalls).toEqual([150, 150]);
  });

  it('retries a 429 and succeeds on the next attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(buildFailedResponse(429))
      .mockResolvedValueOnce(buildJsonResponse({ ok: true }));
    const client = new EdgarClient(
      { userAgent: 'Bot contact@example.com', minIntervalMs: 150 },
      clock,
    );

    const result = await client.fetchJson('https://data.sec.gov/submissions/CIK0000000001.json');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 and succeeds on the next attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(buildFailedResponse(503))
      .mockResolvedValueOnce(buildJsonResponse({ ok: true }));
    const client = new EdgarClient(
      { userAgent: 'Bot contact@example.com', minIntervalMs: 150 },
      clock,
    );

    await expect(
      client.fetchJson('https://data.sec.gov/submissions/CIK0000000001.json'),
    ).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on a non-retryable status without retrying, naming the url and status', async () => {
    fetchMock.mockResolvedValue(buildFailedResponse(404));
    const client = new EdgarClient(
      { userAgent: 'Bot contact@example.com', minIntervalMs: 150 },
      clock,
    );

    await expect(
      client.fetchJson('https://data.sec.gov/submissions/CIK0000000001.json'),
    ).rejects.toThrow(/404.*CIK0000000001/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries on a persistently retryable status', async () => {
    fetchMock.mockResolvedValue(buildFailedResponse(429));
    const client = new EdgarClient(
      { userAgent: 'Bot contact@example.com', minIntervalMs: 150, maxRetries: 2 },
      clock,
    );

    await expect(
      client.fetchJson('https://data.sec.gov/submissions/CIK0000000001.json'),
    ).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fetchBytes returns the response body as a Buffer', async () => {
    fetchMock.mockResolvedValue(buildBytesResponse('hello'));
    const client = new EdgarClient(
      { userAgent: 'Bot contact@example.com', minIntervalMs: 150 },
      clock,
    );

    const bytes = await client.fetchBytes('https://www.sec.gov/Archives/edgar/data/1/aaa/a.htm');

    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString('utf8')).toBe('hello');
  });
});
