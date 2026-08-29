import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalEntity } from '../../api/client';
import ProposalsQueue from './ProposalsQueue';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const proposedAlias = {
  alias: 'Acme Tower, LLC',
  status: 'proposed' as const,
  quote: 'Acme Tower, LLC reported NOI of $1.2M.',
  locator: { kind: 'pdf-page' as const, page: 2, extractorVersion: 'pdf-1' },
  documentVersionId: 'version-1',
  harvestedAt: '2026-07-02T00:00:00.000Z',
};

const entityWithProposal: CanonicalEntity = {
  id: 'entity-1',
  canonicalName: 'Acme Tower',
  aliases: [],
  harvestedAliases: [proposedAlias],
  createdAt: '2026-07-01T00:00:00.000Z',
};

const entityWithNoProposals: CanonicalEntity = {
  id: 'entity-2',
  canonicalName: 'Southpark Commons',
  aliases: [],
  harvestedAliases: [],
  createdAt: '2026-07-02T00:00:00.000Z',
};

describe('ProposalsQueue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows an empty state and a scan action when nothing is proposed', () => {
    render(
      <ProposalsQueue
        entities={[entityWithNoProposals]}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );

    expect(screen.getByText('No proposals to review')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Scan for near matches' })).toHaveLength(1);
  });

  it('lists a proposal with its citation, only for rows carrying one', () => {
    render(
      <ProposalsQueue
        entities={[entityWithProposal, entityWithNoProposals]}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );

    expect(
      screen.getByRole('table', { name: 'Proposed aliases awaiting confirmation.' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Proposed aliases awaiting confirmation' }),
    ).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('Acme Tower')).toBeInTheDocument();
    expect(screen.getByText('Acme Tower, LLC')).toBeInTheDocument();
    expect(screen.getByText('p.2')).toBeInTheDocument();
    expect(screen.getByText(/Acme Tower, LLC reported NOI/)).toBeInTheDocument();
    // Southpark Commons carries no proposal and never appears as a row.
    expect(screen.queryByText('Southpark Commons')).not.toBeInTheDocument();
  });

  it('confirms a proposal, notifying and handing the updated row back to the caller', async () => {
    const applied: CanonicalEntity = {
      ...entityWithProposal,
      harvestedAliases: [{ ...proposedAlias, status: 'applied' }],
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/canonical-entities/entity-1/harvested-aliases/apply') {
        expect(JSON.parse(init?.body as string)).toEqual({ alias: 'Acme Tower, LLC' });
        return Promise.resolve(jsonResponse(applied));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onEntityChanged = vi.fn();

    render(
      <ProposalsQueue
        entities={[entityWithProposal]}
        onEntityChanged={onEntityChanged}
        onScanned={() => Promise.resolve()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await vi.waitFor(() => expect(onEntityChanged).toHaveBeenCalledWith(applied));
  });

  it('rejects a proposal through the revoke endpoint, behind a confirm dialog', async () => {
    const revoked: CanonicalEntity = {
      ...entityWithProposal,
      harvestedAliases: [{ ...proposedAlias, status: 'revoked' }],
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/canonical-entities/entity-1/harvested-aliases/revoke') {
        expect(JSON.parse(init?.body as string)).toEqual({ alias: 'Acme Tower, LLC' });
        return Promise.resolve(jsonResponse(revoked));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onEntityChanged = vi.fn();

    render(
      <ProposalsQueue
        entities={[entityWithProposal]}
        onEntityChanged={onEntityChanged}
        onScanned={() => Promise.resolve()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(screen.getByRole('dialog', { name: 'Reject "Acme Tower, LLC"?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reject alias' }));

    await vi.waitFor(() => expect(onEntityChanged).toHaveBeenCalledWith(revoked));
  });

  it('disables both reject-dialog buttons while the request is in flight, blocking a second click', async () => {
    let resolveReject: (response: Response) => void = () => {};
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/canonical-entities/entity-1/harvested-aliases/revoke') {
        return new Promise<Response>((resolve) => {
          resolveReject = resolve;
        });
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ProposalsQueue
        entities={[entityWithProposal]}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject alias' }));

    expect(screen.getByRole('button', { name: 'Reject alias…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    resolveReject(
      jsonResponse({
        ...entityWithProposal,
        harvestedAliases: [{ ...proposedAlias, status: 'revoked' }],
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows a confirm decision error on the shared error surface, not inside the row, and leaves the row for a retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ message: 'Row changed underneath it' }, 409))),
    );

    render(
      <ProposalsQueue
        entities={[entityWithProposal]}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Row changed underneath it');
    expect(alert.closest('tr')).toBeNull();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('scans for near matches and reloads through the caller-supplied callback', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/canonical-entities/near-matches/scan' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ proposed: 1 }));
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onScanned = vi.fn().mockResolvedValue(undefined);

    render(
      <ProposalsQueue
        entities={[entityWithNoProposals]}
        onEntityChanged={() => {}}
        onScanned={onScanned}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Scan for near matches' }));

    await vi.waitFor(() => expect(onScanned).toHaveBeenCalledOnce());
  });

  it('shows a scan error verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ message: 'Scan is admin-only' }, 403))),
    );

    render(
      <ProposalsQueue
        entities={[entityWithNoProposals]}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Scan for near matches' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Scan is admin-only');
  });
});
