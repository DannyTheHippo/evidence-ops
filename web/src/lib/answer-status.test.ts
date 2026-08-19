import { describe, expect, it } from 'vitest';
import type { Answer } from '../api/client';
import { RUN_STATUS_TONE, answerBadge } from './answer-status';

function answerWith(overrides: Partial<Answer>): Answer {
  return {
    id: 'a1',
    questionText: 'What is the revenue?',
    runStatus: 'completed',
    createdAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  } as Answer;
}

describe('answerBadge', () => {
  it('reports the run status while an answer is not yet completed', () => {
    expect(answerBadge(answerWith({ runStatus: 'queued' }))).toEqual({
      tone: 'neutral',
      label: 'queued',
    });
    expect(answerBadge(answerWith({ runStatus: 'running' }))).toEqual({
      tone: 'info',
      label: 'running',
    });
    expect(answerBadge(answerWith({ runStatus: 'failed' }))).toEqual({
      tone: 'rejected',
      label: 'failed',
    });
  });

  it('describes a completed answer by its outcome', () => {
    expect(answerBadge(answerWith({ outcome: { kind: 'answered' } as Answer['outcome'] }))).toEqual(
      {
        tone: 'verified',
        label: 'answered',
      },
    );
    expect(
      answerBadge(answerWith({ outcome: { kind: 'insufficient_evidence' } as Answer['outcome'] })),
    ).toEqual({ tone: 'info', label: 'insufficient evidence' });
  });

  it('treats a conflict as caution rather than rejection', () => {
    expect(
      answerBadge(answerWith({ outcome: { kind: 'conflicting_evidence' } as Answer['outcome'] })),
    ).toEqual({ tone: 'caution', label: 'conflicting evidence' });
  });

  it('falls back to the run status when a completed answer carries no outcome', () => {
    expect(answerBadge(answerWith({ outcome: undefined }))).toEqual({
      tone: 'neutral',
      label: 'completed',
    });
  });

  it('labels every status in lowercase', () => {
    const labels = (['queued', 'running', 'failed'] as const).map(
      (runStatus) => answerBadge(answerWith({ runStatus })).label,
    );
    for (const label of [...labels, 'answered', 'insufficient evidence', 'conflicting evidence']) {
      expect(label).toBe(label.toLowerCase());
    }
  });

  it('has no tone entry for completed, which the outcome describes instead', () => {
    expect(Object.keys(RUN_STATUS_TONE)).not.toContain('completed');
  });
});
