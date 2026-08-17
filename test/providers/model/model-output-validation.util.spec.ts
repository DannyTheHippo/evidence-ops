import { z } from 'zod/v4';
import {
  estimateTokenCount,
  formatIssuesForRetry,
  safeParseModelJson,
} from '../../../src/providers/model/model-output-validation.util';

describe('estimateTokenCount', () => {
  it('should estimate roughly one token per four characters, rounded up', () => {
    expect(estimateTokenCount('12345678')).toBe(2);
    expect(estimateTokenCount('123456789')).toBe(3);
  });

  it('should return zero for an empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });
});

describe('formatIssuesForRetry', () => {
  it('should render each issue as a bulleted path/message line', () => {
    const formatted = formatIssuesForRetry([
      { path: ['answer'], message: 'Required' },
      { path: ['claims', '0', 'statement'], message: 'Too short' },
    ]);

    expect(formatted).toBe('- answer: Required\n- claims.0.statement: Too short');
  });

  it('should render "(root)" for an empty path', () => {
    const formatted = formatIssuesForRetry([{ path: [], message: 'Response is not valid JSON' }]);

    expect(formatted).toBe('- (root): Response is not valid JSON');
  });
});

describe('safeParseModelJson', () => {
  const schema = z.object({ answer: z.string() });

  it('should return success with the parsed data when the text is valid JSON matching the schema', () => {
    const result = safeParseModelJson('{"answer":"Paris"}', schema);

    expect(result).toEqual({ success: true, data: { answer: 'Paris' } });
  });

  it('should return a failure issue describing the JSON parse error for malformed text', () => {
    const result = safeParseModelJson('not json', schema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].path).toEqual([]);
      expect(result.issues[0].message).toContain('Response is not valid JSON');
    }
  });

  it('should return the zod validation issues, with stringified paths, for JSON that fails the schema', () => {
    const result = safeParseModelJson('{"answer":123}', schema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([expect.objectContaining({ path: ['answer'] })]);
    }
  });
});
