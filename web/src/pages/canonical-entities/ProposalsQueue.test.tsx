import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalEntity } from '../../api/client';
import type { ResolvedVersion } from '../../lib/document-index';
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

// Most cases carry no resolved document, so the row falls back to the raw version id and never
// touches the workbench `Link` — those cases render outside a `MemoryRouter` without issue.
const emptyDocumentIndex = new Map<string, ResolvedVersion>();

// Patches a decision back into `entities` the way CanonicalEntitiesPage does, so a decided row
// actually leaves the queue — a static `entities` prop keeps every row mounted and proves nothing
// about what happens to focus when one goes.
function StatefulQueue({ initial }: { initial: CanonicalEntity[] }) {
  const [entities, setEntities] = useState(initial);
  return (
    <ProposalsQueue
      entities={entities}
      documentIndex={emptyDocumentIndex}
      onEntityChanged={(updated) =>
        setEntities((current) => current.map((row) => (row.id === updated.id ? updated : row)))
      }
      onScanned={() => Promise.resolve()}
    />
  );
}

describe('ProposalsQueue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows an empty state and a scan action when nothing is proposed', () => {
    render(
      <ProposalsQueue
        entities={[entityWithNoProposals]}
        documentIndex={emptyDocumentIndex}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );

    expect(screen.getByText('No proposals to review')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Scan for near matches' })).toHaveLength(1);
  });

  it('lists a proposal with its citation, only for rows carrying one', async () => {
    render(
      <ProposalsQueue
        entities={[entityWithProposal, entityWithNoProposals]}
        documentIndex={emptyDocumentIndex}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Proposed aliases' })).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Proposed aliases awaiting confirmation.' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Proposed aliases awaiting confirmation' }),
    ).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('Acme Tower')).toBeInTheDocument();
    expect(screen.getByText('Acme Tower, LLC')).toBeInTheDocument();
    expect(screen.getByText('p.2')).toBeInTheDocument();
    // Clamped to two lines, so keyboard focus on the quote opens the full text.
    const quote = screen.getByText(/Acme Tower, LLC reported NOI/);
    expect(quote).toHaveAttribute('tabindex', '0');
    quote.focus();
    const quoteTooltip = await screen.findByRole('tooltip');
    expect(quoteTooltip).toHaveTextContent(proposedAlias.quote);
    expect(quote).toHaveAttribute('aria-describedby', quoteTooltip.id);
    // The document is unresolved, so the evidence falls back to the raw version id.
    expect(screen.getByText('version-1')).toBeInTheDocument();
    // Southpark Commons carries no proposal and never appears as a row.
    expect(screen.queryByText('Southpark Commons')).not.toBeInTheDocument();
  });

  it("links a proposal's evidence to the document workbench", () => {
    const documentIndex = new Map<string, ResolvedVersion>([
      [
        'version-1',
        { documentId: 'doc-1', documentTitle: 'Rent Roll Q1', withdrawn: false, sourceKind: 'pdf' },
      ],
    ]);

    render(
      <MemoryRouter>
        <ProposalsQueue
          entities={[entityWithProposal]}
          documentIndex={documentIndex}
          onEntityChanged={() => {}}
          onScanned={() => Promise.resolve()}
        />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Rent Roll Q1' });
    expect(link).toHaveAttribute('href', '/documents/doc-1/versions/version-1');
  });

  it('counts only the proposals from the entities this page loaded, singular and plural alike', () => {
    const { rerender } = render(
      <ProposalsQueue
        entities={[entityWithProposal]}
        documentIndex={emptyDocumentIndex}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );
    expect(screen.getByText('1 proposal on this page')).toBeInTheDocument();

    const secondEntityWithProposal: CanonicalEntity = {
      ...entityWithNoProposals,
      harvestedAliases: [proposedAlias],
    };
    rerender(
      <ProposalsQueue
        entities={[entityWithProposal, secondEntityWithProposal]}
        documentIndex={emptyDocumentIndex}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );
    expect(screen.getByText('2 proposals on this page')).toBeInTheDocument();
  });

  it('gives Confirm a small primary weight and Reject a small ghost weight, not matching pairs', () => {
    render(
      <ProposalsQueue
        entities={[entityWithProposal]}
        documentIndex={emptyDocumentIndex}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Confirm "Acme Tower, LLC" for "Acme Tower"' }),
    ).toHaveClass('btn--primary', 'btn--sm');
    expect(
      screen.getByRole('button', { name: 'Reject "Acme Tower, LLC" for "Acme Tower"' }),
    ).toHaveClass('btn--ghost', 'btn--sm');
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
        documentIndex={emptyDocumentIndex}
        onEntityChanged={onEntityChanged}
        onScanned={() => Promise.resolve()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm "Acme Tower, LLC" for "Acme Tower"' }),
    );

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
        documentIndex={emptyDocumentIndex}
        onEntityChanged={onEntityChanged}
        onScanned={() => Promise.resolve()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Reject "Acme Tower, LLC" for "Acme Tower"' }),
    );
    expect(screen.getByRole('dialog', { name: 'Reject "Acme Tower, LLC"?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reject alias' }));

    await vi.waitFor(() => expect(onEntityChanged).toHaveBeenCalledWith(revoked));
  });

  it('marks the reject-dialog confirm button busy and disables Cancel while the request is in flight, blocking a second click', async () => {
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
        documentIndex={emptyDocumentIndex}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Reject "Acme Tower, LLC" for "Acme Tower"' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reject alias' }));

    const busyButton = screen.getByRole('button', { name: 'Reject alias…' });
    expect(busyButton).toHaveAttribute('aria-busy', 'true');
    // Busy, not disabled — it holds focus while the request is in flight and guards its own click.
    expect(busyButton).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    const rejectCallsBeforeSecondClick = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/v1/canonical-entities/entity-1/harvested-aliases/revoke',
    ).length;
    fireEvent.click(busyButton);
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url === '/api/v1/canonical-entities/entity-1/harvested-aliases/revoke',
      ).length,
    ).toBe(rejectCallsBeforeSecondClick);

    resolveReject(
      jsonResponse({
        ...entityWithProposal,
        harvestedAliases: [{ ...proposedAlias, status: 'revoked' }],
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('moves focus off the decided row instead of dropping it to the body', async () => {
    const secondAlias = { ...proposedAlias, alias: 'Southpark Cmns' };
    const secondEntity: CanonicalEntity = {
      ...entityWithNoProposals,
      harvestedAliases: [secondAlias],
    };
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/v1/canonical-entities/entity-1/harvested-aliases/apply') {
        return Promise.resolve(
          jsonResponse({
            ...entityWithProposal,
            harvestedAliases: [{ ...proposedAlias, status: 'applied' }],
          }),
        );
      }
      if (url === '/api/v1/canonical-entities/entity-2/harvested-aliases/apply') {
        return Promise.resolve(
          jsonResponse({
            ...secondEntity,
            harvestedAliases: [{ ...secondAlias, status: 'applied' }],
          }),
        );
      }
      return Promise.reject(new Error(`Unhandled fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<StatefulQueue initial={[entityWithProposal, secondEntity]} />);

    const [firstConfirm, secondConfirm] = screen.getAllByRole('button', { name: /^Confirm "/ });
    firstConfirm.focus();
    fireEvent.click(firstConfirm);

    // In flight, and still holding focus — the row goes busy rather than disabled, so nothing is
    // dropped to <body> before the row itself leaves.
    expect(firstConfirm).toHaveAttribute('aria-busy', 'true');
    expect(firstConfirm).toBeEnabled();
    expect(firstConfirm).toHaveFocus();

    // The decided row unmounts; focus lands on the row that took its place, not on <body>.
    await vi.waitFor(() => expect(secondConfirm).toHaveFocus());

    fireEvent.click(secondConfirm);

    // Nothing is left to review, so the queue's own heading takes focus.
    await vi.waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Proposed aliases' })).toHaveFocus(),
    );
  });

  it('shows a confirm decision error on the shared error surface, not inside the row, and leaves the row for a retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ message: 'Row changed underneath it' }, 409))),
    );

    render(
      <ProposalsQueue
        entities={[entityWithProposal]}
        documentIndex={emptyDocumentIndex}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm "Acme Tower, LLC" for "Acme Tower"' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Row changed underneath it');
    expect(alert.closest('tr')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Confirm "Acme Tower, LLC" for "Acme Tower"' }),
    ).toBeInTheDocument();
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
        documentIndex={emptyDocumentIndex}
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
        documentIndex={emptyDocumentIndex}
        onEntityChanged={() => {}}
        onScanned={() => Promise.resolve()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Scan for near matches' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Scan is admin-only');
  });
});
