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

  it('should not charge for notifications or responses batched alongside requests', () => {
    const batch = [buildRequest(1), buildNotification(), buildResultResponse(2), buildRequest(3)];

    expect(countRateLimitCost(batch)).toBe(2);
  });

  it('should cost 0 for a batch containing no requests', () => {
    const batch = [buildNotification(), buildResultResponse(1)];

    expect(countRateLimitCost(batch)).toBe(0);
  });

  it('should cost 0 for an empty batch', () => {
    expect(countRateLimitCost([])).toBe(0);
  });
});
