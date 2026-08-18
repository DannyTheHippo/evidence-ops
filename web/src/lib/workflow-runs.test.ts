import { describe, expect, it } from 'vitest';
import { isTerminalRun } from './workflow-runs';

describe('isTerminalRun', () => {
  // `failed` is terminal too — a poller that only stops on `completed` runs forever against a run
  // that will never reach it.
  it('treats both ends of the road as terminal', () => {
    expect(isTerminalRun('completed')).toBe(true);
    expect(isTerminalRun('failed')).toBe(true);
  });

  it('treats a run still moving as non-terminal', () => {
    expect(isTerminalRun('queued')).toBe(false);
    expect(isTerminalRun('running')).toBe(false);
  });
});
