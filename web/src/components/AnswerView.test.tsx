import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Answer } from '../api/client';
import type { ResolvedVersion } from '../lib/document-index';
import AnswerView, { type ConflictChunkResolution } from './AnswerView';

function baseAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: 'answer-1',
    questionText: 'What is the cap rate?',
    runStatus: 'completed',
    citations: [],
    conflictIds: [],
    createdAt: new Date().toISOString(),
    withdrawnCitedDocVersionIds: [],
    ...overrides,
  };
}

function renderView(
  answer: Answer,
  documentIndex = new Map<string, ResolvedVersion>(),
  conflictChunkIndex = new Map<string, ConflictChunkResolution>(),
) {
  return render(
    <MemoryRouter>
      <AnswerView
        answer={answer}
        documentIndex={documentIndex}
        conflictChunkIndex={conflictChunkIndex}
      />
    </MemoryRouter>,
  );
}

describe('AnswerView', () => {
  it('renders nothing for an answer that is not yet completed', () => {
    const { container } = renderView(baseAnswer({ runStatus: 'running' }));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a completed answer with no outcome', () => {
    const { container } = renderView(baseAnswer({ runStatus: 'completed' }));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an answered outcome via the provenance rail, with the ledger above it', () => {
    renderView(
      baseAnswer({
        retrievedChunkCount: 4,
        outcome: {
          kind: 'answered',
          claims: [
            {
              statement: 'The cap rate is 6.1%.',
              citations: [
                {
                  docVersionId: 'docver-1',
                  sha256: 'a'.repeat(64),
                  chunkId: 'chunk-a',
                  locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
                  quote: 'Cap rate: 6.1%',
                },
              ],
            },
          ],
        },
        verificationReport: { verifiedClaimCount: 1, totalClaimCount: 1, droppedClaims: [] },
      }),
    );

    expect(screen.getByText('4 chunks retrieved')).toBeInTheDocument();
    expect(screen.getByText('1 of 1 claim verified against the source')).toBeInTheDocument();
    expect(screen.getByText('The cap rate is 6.1%.')).toBeInTheDocument();
    expect(screen.getByText('Cap rate: 6.1%')).toBeInTheDocument();
    expect(screen.getByText('p.2')).toBeInTheDocument();
  });

  it('forwards documentIndex into the ledger so a verified claim citing a csv document is marked, even though its locator is text-block', () => {
    renderView(
      baseAnswer({
        outcome: {
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
        },
        verificationReport: { verifiedClaimCount: 1, totalClaimCount: 1, droppedClaims: [] },
      }),
      new Map([
        [
          'docver-2',
          {
            documentId: 'doc-2',
            documentTitle: 'noi-summary.csv',
            withdrawn: false,
            sourceKind: 'csv' as const,
          },
        ],
      ]),
    );

    expect(
      screen.getByText(
        '1 verified claim sourced from a spreadsheet or CSV — not verified against the source table',
      ),
    ).toBeInTheDocument();
  });

  it('marks a citation whose docVersionId is withdrawn, resolved from the answer envelope', () => {
    renderView(
      baseAnswer({
        withdrawnCitedDocVersionIds: ['docver-1'],
        outcome: {
          kind: 'answered',
          claims: [
            {
              statement: 'The cap rate is 6.1%.',
              citations: [
                {
                  docVersionId: 'docver-1',
                  sha256: 'a'.repeat(64),
                  chunkId: 'chunk-a',
                  locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
                  quote: 'Cap rate: 6.1%',
                },
              ],
            },
          ],
        },
      }),
    );

    expect(screen.getByText('source withdrawn')).toBeInTheDocument();
  });

  it('renders an insufficient_evidence outcome via the provenance rail, not the value-compare markup', () => {
    renderView(
      baseAnswer({
        outcome: { kind: 'insufficient_evidence', reason: 'No document mentions vacancy.' },
      }),
    );

    expect(screen.getByText('No document mentions vacancy.')).toBeInTheDocument();
    expect(document.querySelector('.value-compare')).not.toBeInTheDocument();
  });

  it('renders a conflicting_evidence outcome as value-compare markup, resolving a matched chunk and falling back to the raw id for an unmatched one', () => {
    renderView(
      baseAnswer({
        conflictIds: ['conflict-1'],
        outcome: {
          kind: 'conflicting_evidence',
          factKey: { entity: 'Northgate Business Park', metric: 'cap_rate', period: '2025-03' },
          values: [
            { value: 6.1, unit: 'percent', sourceChunkId: 'chunk-a' },
            { value: 6.4, unit: 'percent', sourceChunkId: 'chunk-c' },
          ],
        },
      }),
      new Map([
        ['docver-1', { documentId: 'doc-1', documentTitle: 'Rent Roll Q1', withdrawn: false }],
      ]),
      new Map([
        [
          'chunk-a',
          {
            documentVersionId: 'docver-1',
            locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
          },
        ],
      ]),
    );

    expect(
      screen.getByText('Contradiction found for Northgate Business Park — cap_rate (2025-03)'),
    ).toBeInTheDocument();
    expect(screen.getByText('6.1 percent')).toBeInTheDocument();
    expect(screen.getByText('6.4 percent')).toBeInTheDocument();
    expect(screen.getByText('Rent Roll Q1 — p.2')).toBeInTheDocument();
    expect(screen.getByText('chunk-c')).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Competing values for this conflict' }),
    ).toBeInTheDocument();
    // The resolved value links into the workbench at its source chunk; the unresolved one has no
    // document version to link to, so 'chunk-c' above renders as plain text, not a link.
    expect(screen.getByRole('link', { name: 'chunk-a' })).toHaveAttribute(
      'href',
      '/documents/doc-1/versions/docver-1?chunk=chunk-a',
    );
  });

  it('shows the reason for a dropped claim always, and the raw statement only behind its own disclosure', () => {
    // `outcome.claims` carries only the surviving claim — the gate never persists a dropped
    // claim's statement under `outcome` (see `activities.ts`'s `groundingCheck`), and a claim's
    // `citations` is never empty (`claimSchema`'s `min(1)`). `totalClaimCount` above
    // `outcome.claims.length` is what a real, post-verification answer with one dropped claim
    // looks like.
    renderView(
      baseAnswer({
        outcome: {
          kind: 'answered',
          claims: [
            {
              statement: 'The cap rate is 6.1%.',
              citations: [
                {
                  docVersionId: 'docver-1',
                  sha256: 'a'.repeat(64),
                  chunkId: 'chunk-a',
                  locator: { kind: 'pdf-page', extractorVersion: 'v1', page: 2 },
                  quote: 'Cap rate: 6.1%',
                },
              ],
            },
          ],
        },
        verificationReport: {
          verifiedClaimCount: 1,
          totalClaimCount: 2,
          droppedClaims: [
            { statement: 'Occupancy is 95%.', reason: 'No retrieved chunk supports this figure.' },
          ],
        },
      }),
    );

    expect(
      screen.getByRole('heading', {
        level: 3,
        name: '1 claim dropped by the grounding check',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('No retrieved chunk supports this figure.')).toBeInTheDocument();
    // jsdom keeps a closed <details>'s content in the DOM; only visibility reflects `open`.
    expect(screen.getByText('Occupancy is 95%.')).not.toBeVisible();

    fireEvent.click(screen.getByText('Show statement'));

    expect(screen.getByText('Occupancy is 95%.')).toBeVisible();
  });

  it('reframes the dropped-claims band as the reason for the abstention when the outcome is insufficient_evidence', () => {
    renderView(
      baseAnswer({
        outcome: {
          kind: 'insufficient_evidence',
          reason: 'grounding gate verified 0 of 1 claim(s); every citation failed verification',
        },
        verificationReport: {
          verifiedClaimCount: 0,
          totalClaimCount: 1,
          droppedClaims: [
            { statement: 'Occupancy is 95%.', reason: 'No retrieved chunk supports this figure.' },
          ],
        },
      }),
    );

    expect(
      screen.getByText('No claim passed the grounding check — this is why the model abstained.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/claim dropped by the grounding check/)).not.toBeInTheDocument();
  });

  it('states a fully-verified answer once, with no dropped-claims band', () => {
    renderView(
      baseAnswer({
        outcome: {
          kind: 'answered',
          claims: [{ statement: 'The cap rate is 6.1%.', citations: [] }],
        },
        verificationReport: { verifiedClaimCount: 1, totalClaimCount: 1, droppedClaims: [] },
      }),
    );

    expect(screen.getByText('1 of 1 claim verified against the source')).toBeInTheDocument();
    expect(screen.queryByText(/claim.*dropped/)).not.toBeInTheDocument();
    // The ratio is the whole statement on this path: a zero "not asserted" line and a notice
    // restating it would each say the same fact a second and third time, the first as a double
    // negative.
    expect(screen.queryByText(/not asserted/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/was checked against the source and verified/),
    ).not.toBeInTheDocument();
  });

  it('omits the dropped-claims band when the answer carries no verification report', () => {
    renderView(
      baseAnswer({ outcome: { kind: 'insufficient_evidence', reason: 'No evidence found.' } }),
    );

    expect(screen.queryByText(/dropped/)).not.toBeInTheDocument();
  });
});
