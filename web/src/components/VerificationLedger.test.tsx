import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnswerOutcome, VerificationReport } from '../api/client';
import type { ResolvedVersion } from '../lib/document-index';
import VerificationLedger from './VerificationLedger';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

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
    expect(
      screen.getByText(
        'None of the asserted claims passed the grounding check; every one was dropped.',
      ),
    ).toBeInTheDocument();
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

  it('conflicting_evidence: shows the raw metric id before the ontology loads, then the label once it has', async () => {
    // Every other test in this file leaves `metric-labels.ts`'s module-scope cache populated
    // (empty, since none stub `/metrics`) for the rest of the file's run — resetting the module
    // registry and re-importing gives this test its own uncached instance regardless of run order.
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([{ id: 'cap_rate', label: 'Cap rate', canonicalUnit: 'percent' }]),
        ),
    );
    const { default: VerificationLedgerFresh } = await import('./VerificationLedger');

    render(<VerificationLedgerFresh outcome={conflictingEvidence} retrievedChunkCount={3} />);

    expect(
      screen.getByText('Contradiction found for Northgate Business Park — cap_rate (2025-03)'),
    ).toBeInTheDocument();

    expect(
      await screen.findByText(
        'Contradiction found for Northgate Business Park — Cap rate (2025-03)',
      ),
    ).toBeInTheDocument();
  });

  it('marks a verified claim whose citation carries an xlsx locator, with no documentIndex needed', () => {
    const single: VerificationReport = {
      verifiedClaimCount: 1,
      totalClaimCount: 1,
      droppedClaims: [],
    };
    const xlsxOutcome: AnswerOutcome = {
      kind: 'answered',
      claims: [
        {
          statement: 'Cap rate is 6.1%.',
          citations: [
            {
              docVersionId: 'docver-1',
              sha256: 'a'.repeat(64),
              chunkId: 'chunk-a',
              locator: {
                kind: 'xlsx-cell',
                extractorVersion: 'v1',
                sheetName: 'Comps',
                cell: 'B2',
              },
              quote: '6.1%',
            },
          ],
        },
      ],
    };
    render(<VerificationLedger outcome={xlsxOutcome} verificationReport={single} />);

    expect(
      screen.getByText(
        '1 verified claim sourced from a spreadsheet or CSV — not verified against the source table',
      ),
    ).toBeInTheDocument();
  });

  it("marks a verified claim citing a csv document via documentIndex's sourceKind, even though its locator is text-block", () => {
    const single: VerificationReport = {
      verifiedClaimCount: 1,
      totalClaimCount: 1,
      droppedClaims: [],
    };
    const csvOutcome: AnswerOutcome = {
      kind: 'answered',
      claims: [
        {
          statement: 'Occupancy is 95%.',
          citations: [
            {
              docVersionId: 'docver-2',
              sha256: 'b'.repeat(64),
              chunkId: 'chunk-b',
              locator: {
                kind: 'text-block',
                extractorVersion: 'v1',
                blockIndex: 0,
                headingPath: [],
              },
              quote: '95%',
            },
          ],
        },
      ],
    };
    const documentIndex = new Map<string, ResolvedVersion>([
      [
        'docver-2',
        {
          documentId: 'doc-2',
          documentTitle: 'noi-summary.csv',
          withdrawn: false,
          sourceKind: 'csv',
        },
      ],
    ]);
    render(
      <VerificationLedger
        outcome={csvOutcome}
        verificationReport={single}
        documentIndex={documentIndex}
      />,
    );

    expect(
      screen.getByText(
        '1 verified claim sourced from a spreadsheet or CSV — not verified against the source table',
      ),
    ).toBeInTheDocument();
  });

  it('does not mark a verified claim citing a prose document, and omits the marker entirely once none of the verified claims are tabular', () => {
    const single: VerificationReport = {
      verifiedClaimCount: 1,
      totalClaimCount: 1,
      droppedClaims: [],
    };
    const proseOutcome: AnswerOutcome = {
      kind: 'answered',
      claims: [
        {
          statement: 'Cap rate is 6.1%.',
          citations: [
            {
              docVersionId: 'docver-3',
              sha256: 'c'.repeat(64),
              chunkId: 'chunk-c',
              locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 4 },
              quote: '6.1%',
            },
          ],
        },
      ],
    };
    const documentIndex = new Map<string, ResolvedVersion>([
      [
        'docver-3',
        {
          documentId: 'doc-3',
          documentTitle: 'Underwriting Memo',
          withdrawn: false,
          sourceKind: 'pdf',
        },
      ],
    ]);
    render(
      <VerificationLedger
        outcome={proseOutcome}
        verificationReport={single}
        documentIndex={documentIndex}
      />,
    );

    expect(screen.queryByText(/sourced from a spreadsheet or CSV/)).not.toBeInTheDocument();
  });
});
