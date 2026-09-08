import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttestationBundle } from '../api/client';
import AttestationBundleView from './AttestationBundleView';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseBundle(overrides: Partial<AttestationBundle> = {}): AttestationBundle {
  return {
    schemaVersion: 1,
    kind: 'answer',
    subjectId: 'a-1',
    tenantId: 'tenant-a',
    producedAt: '2026-08-01T00:00:00.000Z',
    subject: { question: 'What is the cap rate?' },
    outcome: 'answered',
    claims: [],
    decisions: [],
    measures: [],
    integrity: { algorithm: 'sha256', contentHash: 'a'.repeat(64) },
    ...overrides,
  };
}

// jsdom implements neither method — stubbing the real `URL` class (rather than a bare object)
// keeps every other static/instance behaviour (URLSearchParams parsing elsewhere in the render
// tree) working exactly as it does outside the test.
function stubObjectUrl() {
  let counter = 0;
  const createObjectURL = vi.fn(() => `blob:mock-${(counter += 1)}`);
  const revokeObjectURL = vi.fn();
  class StubUrl extends URL {
    static override createObjectURL = createObjectURL;
    static override revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal('URL', StubUrl);
  return { createObjectURL, revokeObjectURL };
}

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : '';
      const path = url.split('?')[0];
      if (path in routes) return Promise.resolve(jsonResponse(routes[path]));
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    }),
  );
}

function renderView(kind: 'answers' | 'verifications', subjectId: string) {
  return render(
    <MemoryRouter>
      <AttestationBundleView kind={kind} subjectId={subjectId} />
    </MemoryRouter>,
  );
}

describe('AttestationBundleView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders claim verdicts, checks, citations, measures and decisions for an answer bundle', async () => {
    stubFetch({
      '/api/v1/answers/a-1/attestation': baseBundle({
        claims: [
          {
            statement: 'The cap rate was 6.1%.',
            atoms: ['cap rate', '6.1%'],
            verdict: 'grounded',
            citations: [
              {
                documentId: 'doc-1',
                documentVersionId: 'v-1',
                sha256: 'b'.repeat(64),
                locator: { kind: 'pdf-page', extractorVersion: '1', page: 2 },
                extractorVersion: '1',
                quote: 'The cap rate is approximately 6.1%.',
              },
            ],
            checks: [{ name: 'Grounding check', passed: true }],
          },
          {
            statement: 'Occupancy fell to 80%.',
            verdict: 'not_grounded',
            citations: [],
            checks: [{ name: 'Grounding check', passed: false, detail: 'No supporting chunk' }],
          },
        ],
        decisions: [
          {
            factKey: { entity: 'Northgate', metric: 'cap-rate', period: '2026-Q2' },
            outcome: 'resolved',
            winningFactId: 'fact-1',
            decidedBy: 'admin@example.com',
            reason: 'Authoritative source',
            resolvedAt: '2026-07-01T00:00:00.000Z',
            ruleFired: 'authority',
            followedProposal: true,
            conflictId: 'conflict-1',
          },
        ],
        measures: [{ slug: 'cap-rate', version: 2, status: 'confirmed' }],
      }),
      '/api/v1/documents/versions/lookup': {
        docs: [
          {
            versionId: 'v-1',
            documentId: 'doc-1',
            documentTitle: 'Q3 Rent Roll',
            versionNumber: 1,
            withdrawn: false,
            sourceKind: 'pdf',
          },
        ],
        count: 1,
      },
    });

    renderView('answers', 'a-1');

    expect(await screen.findByText('The cap rate was 6.1%.')).toBeInTheDocument();
    expect(screen.getByText('grounded')).toHaveClass('badge--strong');
    expect(screen.getByText('not_grounded')).toHaveClass('badge--reject');
    expect(screen.getByText('Grounding check — passed')).toBeInTheDocument();
    expect(screen.getByText(/Grounding check — failed/)).toBeInTheDocument();
    expect(screen.getByText('No supporting chunk')).toBeInTheDocument();
    expect(screen.getByText('cap-rate v2 (confirmed)')).toBeInTheDocument();

    const decisionLink = await screen.findByRole('link', { name: 'Open in Adjudication' });
    expect(decisionLink).toHaveAttribute(
      'href',
      '/adjudication?kind=conflicts&selected=conflict-1',
    );
    expect(screen.getByText(/Northgate · cap-rate · 2026-Q2/)).toBeInTheDocument();

    const citationLink = await screen.findByRole('link', { name: 'Q3 Rent Roll' });
    expect(citationLink).toHaveAttribute('href', '/documents/doc-1/versions/v-1');
  });

  it('renders no workbench link for a citation with documentId: null, keeping the locator chip', async () => {
    stubFetch({
      '/api/v1/answers/a-1/attestation': baseBundle({
        claims: [
          {
            statement: 'Unresolved citation.',
            verdict: 'no_evidence_retrieved',
            citations: [
              {
                documentId: null,
                documentVersionId: 'v-2',
                sha256: 'c'.repeat(64),
                locator: {
                  kind: 'xlsx-cell',
                  extractorVersion: '1',
                  sheetName: 'Comps',
                  cell: 'F2',
                },
                extractorVersion: '1',
                quote: 'Some quote.',
              },
            ],
            checks: [],
          },
        ],
      }),
      '/api/v1/documents/versions/lookup': { docs: [], count: 0 },
    });

    renderView('answers', 'a-1');

    expect(await screen.findByText('Comps!F2')).toBeInTheDocument();
    expect(screen.getByText('no_evidence_retrieved')).toHaveClass('badge--neutral');
    expect(screen.queryByRole('link', { name: /Comps/ })).not.toBeInTheDocument();
  });

  it('states no adjudication decisions apply when the bundle carries none', async () => {
    stubFetch({
      '/api/v1/verifications/v-1/attestation': baseBundle({
        kind: 'verification',
        subjectId: 'v-1',
      }),
      '/api/v1/documents/versions/lookup': { docs: [], count: 0 },
    });

    renderView('verifications', 'v-1');

    expect(
      await screen.findByText('No adjudication decisions apply to this attestation.'),
    ).toBeInTheDocument();
  });

  it('downloads the bundle as a named JSON file and revokes the object URL afterwards', async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    stubFetch({
      '/api/v1/verifications/v-1/attestation': baseBundle({
        kind: 'verification',
        subjectId: 'v-1',
      }),
      '/api/v1/documents/versions/lookup': { docs: [], count: 0 },
    });

    renderView('verifications', 'v-1');
    const button = await screen.findByRole('button', { name: 'Download attestation' });
    await waitFor(() => expect(button).toBeEnabled());
    button.click();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicked).toEqual(['attestation-verification-v-1.json']);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
  });

  it('renders an alert when the attestation fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Network down'))),
    );

    renderView('answers', 'a-1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
  });
});
