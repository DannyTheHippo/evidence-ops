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

  it('renders an answered outcome via the provenance rail', () => {
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
      }),
    );

    expect(screen.getByText('The cap rate is 6.1%.')).toBeInTheDocument();
    expect(screen.getByText('Cap rate: 6.1%')).toBeInTheDocument();
    expect(screen.getByText('p.2')).toBeInTheDocument();
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
      new Map([['docver-1', { documentId: 'doc-1', documentTitle: 'Rent Roll Q1' }]]),
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

    expect(screen.getByText('6.1 percent')).toBeInTheDocument();
    expect(screen.getByText('6.4 percent')).toBeInTheDocument();
    expect(screen.getByText('Rent Roll Q1 — p.2')).toBeInTheDocument();
    expect(screen.getByText('chunk-c')).toBeInTheDocument();
  });

  it('renders the verification panel disclosure for a dropped claim', () => {
    renderView(
      baseAnswer({
        outcome: { kind: 'insufficient_evidence', reason: 'No document mentions occupancy.' },
        verificationReport: {
          verifiedClaimCount: 1,
          totalClaimCount: 2,
          droppedClaims: [
            { statement: 'Occupancy is 95%.', reason: 'No retrieved chunk supports this figure.' },
          ],
        },
      }),
    );

    expect(screen.getByText('1 of 2 claims verified against the source')).toBeInTheDocument();
    fireEvent.click(screen.getByText('1 claim dropped — not verified against the source'));
    expect(screen.getByText('Occupancy is 95%.')).toBeInTheDocument();
    expect(screen.getByText('No retrieved chunk supports this figure.')).toBeInTheDocument();
  });

  it('renders the fully-verified notice, not a disclosure, when nothing was dropped', () => {
    renderView(
      baseAnswer({
        outcome: { kind: 'insufficient_evidence', reason: 'No document mentions occupancy.' },
        verificationReport: { verifiedClaimCount: 1, totalClaimCount: 1, droppedClaims: [] },
      }),
    );

    expect(
      screen.getByText('Every claim in this answer was checked against the source and verified.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/claim.*dropped/)).not.toBeInTheDocument();
  });

  it('omits the verification panel when the answer carries no verification report', () => {
    renderView(
      baseAnswer({ outcome: { kind: 'insufficient_evidence', reason: 'No evidence found.' } }),
    );

    expect(screen.queryByText(/claims verified against the source/)).not.toBeInTheDocument();
  });
});
