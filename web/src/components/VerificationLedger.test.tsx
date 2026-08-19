import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AnswerOutcome, VerificationReport } from '../api/client';
import VerificationLedger from './VerificationLedger';

const answered: AnswerOutcome = {
  kind: 'answered',
  claims: [{ statement: 'The cap rate is 6.1%.', citations: [] }],
};
const insufficientEvidence: AnswerOutcome = {
  kind: 'insufficient_evidence',
  reason: 'No document mentions vacancy.',
};
const conflictingEvidence: AnswerOutcome = {
  kind: 'conflicting_evidence',
  factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
  values: [],
};

const report: VerificationReport = {
  verifiedClaimCount: 1,
  totalClaimCount: 2,
  droppedClaims: [{ statement: 'Occupancy is 95%.', reason: 'No retrieved chunk supports this.' }],
};

describe('VerificationLedger', () => {
  it('answered, report present: renders the full funnel, retrieved through not-asserted', () => {
    render(
      <VerificationLedger outcome={answered} verificationReport={report} retrievedChunkCount={9} />,
    );

    expect(screen.getByText('9 chunks retrieved')).toBeInTheDocument();
    expect(screen.getByText('2 claims asserted')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 claims verified against the source')).toBeInTheDocument();
    expect(screen.getByText('1 not asserted')).toBeInTheDocument();
  });

  it('answered, report absent: falls back to the retrieved count alone', () => {
    render(<VerificationLedger outcome={answered} retrievedChunkCount={9} />);

    expect(screen.getByText('9 chunks retrieved')).toBeInTheDocument();
    expect(screen.queryByText(/claims verified against the source/)).not.toBeInTheDocument();
    expect(screen.queryByText(/claims asserted/)).not.toBeInTheDocument();
  });

  it("insufficient_evidence, report present (the grounding gate's own degradation): renders the funnel, not a dominant 0%", () => {
    const allDropped: VerificationReport = {
      verifiedClaimCount: 0,
      totalClaimCount: 1,
      droppedClaims: [
        { statement: 'Occupancy is 95%.', reason: 'No retrieved chunk supports this.' },
      ],
    };
    render(
      <VerificationLedger
        outcome={insufficientEvidence}
        verificationReport={allDropped}
        retrievedChunkCount={5}
      />,
    );

    expect(screen.getByText('5 chunks retrieved')).toBeInTheDocument();
    expect(screen.getByText('0 of 1 claim verified against the source')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByText(/^0%$/)).not.toBeInTheDocument();
    expect(screen.getByText(/none of the asserted claims could be verified/i)).toBeInTheDocument();
  });

  it('insufficient_evidence, report absent (a model-authored abstention): frames it as an abstention, never a 0%', () => {
    render(<VerificationLedger outcome={insufficientEvidence} retrievedChunkCount={6} />);

    expect(screen.getByText('6 chunks retrieved')).toBeInTheDocument();
    expect(
      screen.getByText('No claims asserted — the model found insufficient evidence to answer.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/claims verified against the source/)).not.toBeInTheDocument();
  });

  it('conflicting_evidence, report present: never renders a claim ratio, even though the counts exist', () => {
    render(
      <VerificationLedger
        outcome={conflictingEvidence}
        verificationReport={report}
        retrievedChunkCount={7}
      />,
    );

    expect(screen.getByText('7 chunks retrieved')).toBeInTheDocument();
    expect(
      screen.getByText('Contradiction found for Northgate Business Park — cap_rate (2025-03)'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/claims verified against the source/)).not.toBeInTheDocument();
    expect(screen.queryByText(/claims asserted/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not asserted/)).not.toBeInTheDocument();
  });

  it('conflicting_evidence, report absent: names the contradiction, still no claim ratio', () => {
    render(<VerificationLedger outcome={conflictingEvidence} retrievedChunkCount={3} />);

    expect(screen.getByText('3 chunks retrieved')).toBeInTheDocument();
    expect(
      screen.getByText('Contradiction found for Northgate Business Park — cap_rate (2025-03)'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/claims verified against the source/)).not.toBeInTheDocument();
  });

  it('omits the retrieved line entirely when retrievedChunkCount is not a number', () => {
    render(<VerificationLedger outcome={answered} verificationReport={report} />);

    expect(screen.queryByText(/retrieved$/)).not.toBeInTheDocument();
  });

  it('a fully-verified answer states the ratio alone: no zero line, no ok notice', () => {
    const clean: VerificationReport = {
      verifiedClaimCount: 2,
      totalClaimCount: 2,
      droppedClaims: [],
    };
    render(<VerificationLedger outcome={answered} verificationReport={clean} />);

    expect(screen.getByText('2 of 2 claims verified against the source')).toBeInTheDocument();
    expect(
      screen.queryByText('Every claim in this answer was checked against the source and verified.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/not asserted/)).not.toBeInTheDocument();
  });

  it('a single-claim answer states the ratio in the singular', () => {
    const single: VerificationReport = {
      verifiedClaimCount: 1,
      totalClaimCount: 1,
      droppedClaims: [],
    };
    render(<VerificationLedger outcome={answered} verificationReport={single} />);

    expect(screen.getByText('1 of 1 claim verified against the source')).toBeInTheDocument();
  });
});
