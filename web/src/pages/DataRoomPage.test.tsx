import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import { FakeEventSource } from '../test/fake-event-source';
import DataRoomPage from './DataRoomPage';

describe('DataRoomPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // useSession() shares auth.ts's module-level session cache; without this, whichever role
    // the detail-route test probes for would leak into a later test.
    clearSession();
  });

  it('renders the document list at /documents', () => {
    // Stubbing EventSource keeps DocumentList's stream connecting rather than falling back to a
    // fetch this test never stubs.
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);

    render(
      <MemoryRouter initialEntries={['/documents']}>
        <Routes>
          <Route path="/documents" element={<DataRoomPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Data room' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Upload' })).toBeInTheDocument();
  });

  it('renders the document detail view at /documents/:id', () => {
    // Never resolves — this route only needs to prove DataRoomPage picked DocumentDetail, not
    // that a document loaded (DocumentDetail's own tests cover that).
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );

    render(
      <MemoryRouter initialEntries={['/documents/doc-1']}>
        <Routes>
          <Route path="/documents/:id" element={<DataRoomPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Back to data room' })).toBeInTheDocument();
  });
});
