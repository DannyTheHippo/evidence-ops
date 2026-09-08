import { describe, expect, it } from 'vitest';
import { approvalStateTone, conflictStatusTone } from './adjudication-status';

describe('conflictStatusTone', () => {
  it('maps every conflict status to its badge tone', () => {
    expect(conflictStatusTone('open')).toBe('caution');
    expect(conflictStatusTone('resolved')).toBe('verified');
    expect(conflictStatusTone('dismissed')).toBe('neutral');
  });
});

describe('approvalStateTone', () => {
  it('maps every approval state to its badge tone', () => {
    expect(approvalStateTone.pending).toBe('caution');
    expect(approvalStateTone.approved).toBe('verified');
    expect(approvalStateTone.rejected).toBe('rejected');
    expect(approvalStateTone.timed_out).toBe('neutral');
  });
});
