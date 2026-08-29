import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EntityEditorDialog from './EntityEditorDialog';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const existingEntity = {
  id: 'entity-1',
  canonicalName: 'Northgate Plaza',
  aliases: ['Northgate', 'Northgate Shopping Center'],
  // The dialog edits operator-authored aliases only; harvested ones are read from documents and
  // are not part of what it submits.
  harvestedAliases: [],
  createdAt: '2026-07-01T00:00:00.000Z',
};

describe('EntityEditorDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens empty in create mode', () => {
    render(<EntityEditorDialog onClose={() => {}} onSaved={() => {}} />);

    expect(screen.getByRole('dialog', { name: 'Add alias group' })).toBeInTheDocument();
    expect(screen.getByLabelText('Canonical name')).toHaveValue('');
    expect(screen.getByLabelText('Aliases (optional)')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Add entity' })).toBeInTheDocument();
  });

  it('opens prefilled, one alias per line, in edit mode', () => {
    render(<EntityEditorDialog entity={existingEntity} onClose={() => {}} onSaved={() => {}} />);

    expect(screen.getByRole('dialog', { name: 'Edit "Northgate Plaza"' })).toBeInTheDocument();
    expect(screen.getByLabelText('Canonical name')).toHaveValue('Northgate Plaza');
    expect(screen.getByLabelText('Aliases (optional)')).toHaveValue(
      'Northgate\nNorthgate Shopping Center',
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('creates an entity, trimming blank alias lines', async () => {
    const created = {
      id: 'entity-2',
      canonicalName: 'Southpark Commons',
      aliases: ['Southpark'],
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(created, 201)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    render(<EntityEditorDialog onClose={() => {}} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Southpark Commons' },
    });
    fireEvent.change(screen.getByLabelText('Aliases (optional)'), {
      target: { value: '  Southpark  \n\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add entity' }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/canonical-entities');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      canonicalName: 'Southpark Commons',
      aliases: ['Southpark'],
    });
  });

  it('saves an edit against the entity id, not the collection endpoint', async () => {
    const updated = { ...existingEntity, canonicalName: 'Northgate Plaza II' };
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(updated)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    render(<EntityEditorDialog entity={existingEntity} onClose={() => {}} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Northgate Plaza II' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/canonical-entities/entity-1');
    expect(init.method).toBe('PATCH');
  });

  it('renders a duplicate-name conflict verbatim and keeps the dialog open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ message: 'An alias group named "Northgate Plaza" already exists' }, 409),
        ),
      ),
    );
    const onSaved = vi.fn();

    render(<EntityEditorDialog onClose={() => {}} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Northgate Plaza' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add entity' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An alias group named "Northgate Plaza" already exists',
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('calls onClose from the cancel action', () => {
    const onClose = vi.fn();
    render(<EntityEditorDialog onClose={onClose} onSaved={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('submits on Enter from the canonical name field, but Enter in the aliases textarea never submits', async () => {
    const created = {
      id: 'entity-3',
      canonicalName: 'Lakeside Mall',
      aliases: ['Lakeside', 'Lake Mall'],
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(created, 201)));
    vi.stubGlobal('fetch', fetchMock);

    render(<EntityEditorDialog onClose={() => {}} onSaved={() => {}} />);

    const aliasesField = screen.getByLabelText('Aliases (optional)');
    // A real browser inserts the newline itself and never submits from a <textarea> on Enter;
    // jsdom does neither, so the value change below stands in for what that keystroke produces —
    // the assertion that matters here is that no request follows it.
    fireEvent.change(aliasesField, { target: { value: 'Lakeside\nLake Mall' } });
    fireEvent.keyDown(aliasesField, { key: 'Enter' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(aliasesField).toHaveValue('Lakeside\nLake Mall');

    const nameField = screen.getByLabelText('Canonical name');
    fireEvent.change(nameField, { target: { value: 'Lakeside Mall' } });
    fireEvent.keyDown(nameField, { key: 'Enter' });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });

  it('flags case-insensitive duplicate alias lines without calling the server', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<EntityEditorDialog onClose={() => {}} onSaved={() => {}} />);

    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Northgate Plaza' },
    });
    fireEvent.change(screen.getByLabelText('Aliases (optional)'), {
      target: { value: 'Northgate\nnorthgate' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add entity' }));

    expect(screen.getByText('Aliases repeat: northgate')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('folds an indexed aliases.0 server-validation error onto the aliases field, not the form banner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            {
              message: 'Validation failed',
              errors: [{ field: 'aliases.0', message: 'each value in aliases must be a string' }],
            },
            400,
          ),
        ),
      ),
    );
    const onSaved = vi.fn();

    render(<EntityEditorDialog onClose={() => {}} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText('Canonical name'), {
      target: { value: 'Lakeside Mall' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add entity' }));

    // `useFormSubmit` matches a dotted field path on its root segment, so `aliases.0` lands on the
    // `aliases` control rather than the form-level banner.
    expect(await screen.findByText('each value in aliases must be a string')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
