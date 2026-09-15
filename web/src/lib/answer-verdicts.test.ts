import { describe, expect, it } from 'vitest';
import type { VerifyClaimResult } from '../api/client';
import {
  BUNDLE_VERDICT_LABELS,
  DECISION_OUTCOME_LABELS,
  VERDICT_LABELS,
  answerOutcomeLabel,
  verdictTally,
} from './answer-verdicts';

function resultWith(verdict: VerifyClaimResult['verdict']): VerifyClaimResult {
  return { claimIndex: 0, verdict };
}

describe('verdictTally', () => {
  it('tallies verdicts in label order, omitting verdicts no claim reached', () => {
    expect(
      verdictTally([
        resultWith('conflicting_evidence'),
        resultWith('grounded'),
        resultWith('grounded'),
        resultWith('not_grounded'),
      ]),
    ).toBe('2 grounded · 1 not grounded · 1 conflicting evidence');
  });

  it('returns an empty line for no results', () => {
    expect(verdictTally([])).toBe('');
  });
});

describe('BUNDLE_VERDICT_LABELS', () => {
  it('labels every bundle verdict, including the two bundle-only ones', () => {
    expect(BUNDLE_VERDICT_LABELS).toEqual({
      ...VERDICT_LABELS,
      survived: 'survived',
      dropped: 'dropped',
    });
  });
});

describe('answerOutcomeLabel', () => {
  it('labels the three known outcomes and a missing one', () => {
    expect(answerOutcomeLabel('answered')).toBe('answered');
    expect(answerOutcomeLabel('insufficient_evidence')).toBe('insufficient evidence');
    expect(answerOutcomeLabel('conflicting_evidence')).toBe('conflicting evidence');
    expect(answerOutcomeLabel(null)).toBe('—');
  });

  it('falls back to the raw value for an unrecognised outcome', () => {
    expect(answerOutcomeLabel('some_future_outcome')).toBe('some_future_outcome');
  });
});

describe('DECISION_OUTCOME_LABELS', () => {
  it('labels every ledger decision outcome', () => {
    expect(DECISION_OUTCOME_LABELS).toEqual({
      resolved: 'resolved',
      rejected: 'rejected',
      timed_out: 'timed out',
      superseded: 'superseded',
      retracted: 'retracted',
    });
  });
});
