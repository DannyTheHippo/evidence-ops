import { countRateLimitCost } from '../../src/mcp/count-rate-limit-cost.util';

function buildRequest(id: number, method = 'tools/call') {
  return { jsonrpc: '2.0' as const, id, method, params: {} };
}

function buildNotification(method = 'notifications/initialized') {
  return { jsonrpc: '2.0' as const, method, params: {} };
}

function buildResultResponse(id: number) {
  return { jsonrpc: '2.0' as const, id, result: {} };
}

describe('countRateLimitCost', () => {
  it('should cost exactly 1 for a single, non-batched JSON-RPC request', () => {
    expect(countRateLimitCost(buildRequest(1))).toBe(1);
  });

  it('should cost exactly 1 for a non-array body regardless of shape', () => {
    expect(countRateLimitCost({ not: 'a valid jsonrpc message' })).toBe(1);
    expect(countRateLimitCost(null)).toBe(1);
    expect(countRateLimitCost('a string body')).toBe(1);
  });

  it('should cost the number of requests in a batch — the exploit this closes', () => {
    const batch = Array.from({ length: 800 }, (_unused, index) => buildRequest(index));

    expect(countRateLimitCost(batch)).toBe(800);
  });

  it('should count only requests when a batch mixes requests, notifications and responses', () => {
    const batch = [buildRequest(1), buildNotification(), buildResultResponse(2), buildRequest(3)];

    expect(countRateLimitCost(batch)).toBe(2);
  });

  describe('cost floor — every POST that reaches the limiter costs at least 1', () => {
    it.each([
      ['an empty array', []],
      ['a batch of only notifications', [buildNotification(), buildNotification('other')]],
      ['a batch of only responses', [buildResultResponse(1), buildResultResponse(2)]],
      ['a batch mixing notifications and responses', [buildNotification(), buildResultResponse(1)]],
      ['a non-array body', { not: 'a valid jsonrpc message' }],
      ['a malformed body', null],
    ])('should charge at least 1 for %s', (_description, body) => {
      expect(countRateLimitCost(body)).toBeGreaterThanOrEqual(1);
    });

    it('should floor an all-notification batch at exactly 1', () => {
      const batch = [buildNotification(), buildResultResponse(1)];

      expect(countRateLimitCost(batch)).toBe(1);
    });

    it('should floor an empty batch at exactly 1', () => {
      expect(countRateLimitCost([])).toBe(1);
    });
  });
});
