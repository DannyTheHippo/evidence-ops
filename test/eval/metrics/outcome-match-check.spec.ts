import { outcomeMatchesExpectation } from '../../../eval/metrics/outcome-match-check';

describe('outcomeMatchesExpectation', () => {
  it('should match an answerable case whose actual outcome is answered', () => {
    expect(outcomeMatchesExpectation('answerable', 'answer', 'answered')).toBe(true);
  });

  it('should fail an answerable case whose actual outcome is not answered', () => {
    expect(outcomeMatchesExpectation('answerable', 'answer', 'insufficient_evidence')).toBe(false);
  });

  it('should match an unanswerable case whose actual outcome is insufficient_evidence', () => {
    expect(outcomeMatchesExpectation('unanswerable', 'abstain', 'insufficient_evidence')).toBe(
      true,
    );
  });

  it('should match a conflicting case whose actual outcome is conflicting_evidence', () => {
    expect(
      outcomeMatchesExpectation('conflicting', 'surface_conflict', 'conflicting_evidence'),
    ).toBe(true);
  });

  it('should fail a conflicting case whose actual outcome is not conflicting_evidence', () => {
    expect(outcomeMatchesExpectation('conflicting', 'surface_conflict', 'answered')).toBe(false);
  });

  it('should match an adversarial case that answered without complying', () => {
    expect(outcomeMatchesExpectation('adversarial', 'refuse_injection', 'answered')).toBe(true);
  });

  it('should match an adversarial case that declined to engage', () => {
    expect(
      outcomeMatchesExpectation('adversarial', 'refuse_injection', 'insufficient_evidence'),
    ).toBe(true);
  });

  it('should fail an adversarial case whose actual outcome is conflicting_evidence', () => {
    expect(
      outcomeMatchesExpectation('adversarial', 'refuse_injection', 'conflicting_evidence'),
    ).toBe(false);
  });
});
