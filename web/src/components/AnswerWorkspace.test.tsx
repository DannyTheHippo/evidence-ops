import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Answer } from '../api/client';
import { clearSession } from '../lib/auth';
import AnswerWorkspace from './AnswerWorkspace';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: 'answer-1',
    questionText: 'What is the cap rate?',
    runStatus: 'completed',
    outcome: { kind: 'insufficient_evidence', reason: 'No document mentions the cap rate.' },
    citations: [],
    conflictIds: [],
    createdAt: new Date().toISOString(),
    withdrawnCitedDocVersionIds: [],
    ...overrides,
  };
}

const admin = {
  id: 'user-1',
  email: 'admin@example.com',
  role: 'admin' as const,
  createdAt: new Date().toISOString(),
};

const member = {
  id: 'user-2',
  email: 'member@example.com',
  role: 'member' as const,
  createdAt: new Date().toISOString(),
};

// `useSession()` probes `/auth/me` on mount — dispatch by URL and reject everything else, so an
// unexpected fetch from AnswerView's own enrichment effects fails loudly instead of hanging.
function stubSession(me: typeof admin | typeof member) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : '';
      return url === '/api/v1/auth/me'
        ? Promise.resolve(jsonResponse(me))
        : Promise.reject(new Error(`Unhandled fetch: ${url}`));
    }),
  );
}

function renderWorkspace(answer: Answer, variant: 'ask' | 'detail' = 'ask') {
  return render(
    <MemoryRouter>
      <AnswerWorkspace answer={answer} variant={variant} />
    </MemoryRouter>,
  );
}

describe('AnswerWorkspace', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
  });

  it('repeats the question as its own heading and shows a full skeleton for an ask-variant run in flight', async () => {
    stubSession(member);
    renderWorkspace(baseAnswer({ runStatus: 'running', outcome: undefined }), 'ask');

    expect(screen.getByRole('heading', { name: 'What is the cap rate?' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Answering…');
    await screen.findByRole('heading', { name: 'What is the cap rate?' });
  });

  it('leaves the heading to the caller and shows the lighter notice for a detail-variant run in flight', async () => {
    stubSession(member);
    renderWorkspace(baseAnswer({ runStatus: 'running', outcome: undefined }), 'detail');

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(
      await screen.findByText('Still answering — check back once this run completes.'),
    ).toBeInTheDocument();
  });

  it('shows the failed notice for a failed run', async () => {
    stubSession(member);
    renderWorkspace(baseAnswer({ runStatus: 'failed', outcome: undefined }), 'ask');

    expect(await screen.findByRole('alert')).toHaveTextContent('The question run failed.');
  });

  it("shows an admin the run's cost", async () => {
    stubSession(admin);
    renderWorkspace(
      baseAnswer({ usage: { promptTokens: 1240, completionTokens: 180, costUsd: 0.0042 } }),
    );

    expect(await screen.findByText('Cost: $0.0042')).toBeInTheDocument();
  });

  it('never shows cost to a member', async () => {
    stubSession(member);
    renderWorkspace(
      baseAnswer({ usage: { promptTokens: 1240, completionTokens: 180, costUsd: 0.0042 } }),
    );

    await screen.findByText('No document mentions the cap rate.');
    expect(screen.queryByText(/Cost:/)).not.toBeInTheDocument();
  });
});
