import {
  BAR_1_MIN_GATE_FAILURE_RATE,
  BAR_2_MIN_CORRECT_CATCH_RATE,
  countVerdicts,
  evaluateBar,
  gateFailureRate,
  isGateFailure,
} from '../../../../scripts/experiments/verifier/verdict-metrics';
import { makeOutcome, makeOutcomes } from './verifier-fixtures';

describe('verdict metrics', () => {
  it('holds the pre-registered thresholds', () => {
    expect(BAR_1_MIN_GATE_FAILURE_RATE).toBe(0.2);
    expect(BAR_2_MIN_CORRECT_CATCH_RATE).toBe(0.7);
  });

  it('counts every verdict, including the ones outside the bars', () => {
    const outcomes = [
      ...makeOutcomes(3, 'grounded', 1),
      ...makeOutcomes(2, 'not_grounded', 4),
      ...makeOutcomes(1, 'no_evidence_retrieved', 6),
      ...makeOutcomes(4, 'conflicting_evidence', 7),
    ];

    expect(countVerdicts(outcomes)).toEqual({
      grounded: 3,
      not_grounded: 2,
      no_evidence_retrieved: 1,
      conflicting_evidence: 4,
    });
  });

  it('treats not_grounded and no_evidence_retrieved as gate failures, and nothing else', () => {
    expect(isGateFailure(makeOutcome({ verdict: 'not_grounded' }))).toBe(true);
    expect(isGateFailure(makeOutcome({ verdict: 'no_evidence_retrieved' }))).toBe(true);
    expect(isGateFailure(makeOutcome({ verdict: 'grounded' }))).toBe(false);
    expect(isGateFailure(makeOutcome({ verdict: 'conflicting_evidence' }))).toBe(false);
  });

  it('rates gate failures over every drafted claim, conflicting_evidence included in the denominator', () => {
    const rate = gateFailureRate({
      grounded: 70,
      not_grounded: 18,
      no_evidence_retrieved: 2,
      conflicting_evidence: 10,
    });

    expect(rate).toBeCloseTo(0.2, 10);
  });

  it('reports zero for an empty run rather than NaN', () => {
    expect(
      gateFailureRate({
        grounded: 0,
        not_grounded: 0,
        no_evidence_retrieved: 0,
        conflicting_evidence: 0,
      }),
    ).toBe(0);
  });

  it('meets a bar exactly at the threshold and misses just below it', () => {
    expect(evaluateBar(0.2, BAR_1_MIN_GATE_FAILURE_RATE).met).toBe(true);
    expect(evaluateBar(0.19999, BAR_1_MIN_GATE_FAILURE_RATE).met).toBe(false);
    expect(evaluateBar(0.7, BAR_2_MIN_CORRECT_CATCH_RATE)).toEqual({
      threshold: 0.7,
      observed: 0.7,
      met: true,
    });
  });
});
