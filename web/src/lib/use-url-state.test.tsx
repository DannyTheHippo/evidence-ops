import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useUrlState } from './use-url-state';

interface Filters extends Record<string, string> {
  status: string;
  sort: string;
}

const DEFAULTS: Filters = { status: 'all', sort: 'newest' };

function ListHarness() {
  const [state, setState] = useUrlState(DEFAULTS);
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <p>status: {state.status}</p>
      <p>sort: {state.sort}</p>
      <p>search: {location.search}</p>
      <button onClick={() => setState({ status: 'active' })}>set status</button>
      <button onClick={() => setState({ sort: 'name' })}>set sort</button>
      <button onClick={() => void navigate(-1)}>back</button>
    </div>
  );
}

function OtherPage() {
  return <p>other page</p>;
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/other', '/list']} initialIndex={1}>
      <Routes>
        <Route path="/other" element={<OtherPage />} />
        <Route path="/list" element={<ListHarness />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('useUrlState', () => {
  it('reads defaults for every key absent from the URL, and omits them from the address bar', () => {
    renderList();

    expect(screen.getByText('status: all')).toBeInTheDocument();
    expect(screen.getByText('sort: newest')).toBeInTheDocument();
    expect(screen.getByText('search:')).toBeInTheDocument();
  });

  it('round-trips a non-default value into the URL', () => {
    renderList();

    act(() => {
      screen.getByRole('button', { name: 'set status' }).click();
    });

    expect(screen.getByText('status: active')).toBeInTheDocument();
    expect(screen.getByText('search: ?status=active')).toBeInTheDocument();
  });

  it('merges a patch over the current state instead of replacing it', () => {
    renderList();

    act(() => {
      screen.getByRole('button', { name: 'set status' }).click();
    });
    act(() => {
      screen.getByRole('button', { name: 'set sort' }).click();
    });

    expect(screen.getByText('status: active')).toBeInTheDocument();
    expect(screen.getByText('sort: name')).toBeInTheDocument();
    expect(screen.getByText('search: ?status=active&sort=name')).toBeInTheDocument();
  });

  it('does not grow history — repeated updates still leave a single Back at the prior page', () => {
    renderList();

    act(() => {
      screen.getByRole('button', { name: 'set status' }).click();
    });
    act(() => {
      screen.getByRole('button', { name: 'set sort' }).click();
    });
    act(() => {
      screen.getByRole('button', { name: 'set status' }).click();
    });

    act(() => {
      screen.getByRole('button', { name: 'back' }).click();
    });

    expect(screen.getByText('other page')).toBeInTheDocument();
  });
});
