import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import Table, { RowLink, TableHeaderCell, TableRow } from './Table';

describe('Table', () => {
  it('exposes the caption as the table role accessible name', () => {
    render(
      <Table caption="API keys">
        <thead>
          <tr>
            <TableHeaderCell>Name</TableHeaderCell>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>CI integration</td>
          </tr>
        </tbody>
      </Table>,
    );

    expect(screen.getByRole('table', { name: 'API keys' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('scope', 'col');
  });

  it('renders a plain row unchanged when TableRow carries no destination', () => {
    render(
      <MemoryRouter>
        <Table caption="Sources">
          <tbody>
            <TableRow>
              <td>No destination</td>
            </TableRow>
          </tbody>
        </Table>
      </MemoryRouter>,
    );

    const row = screen.getByText('No destination').closest('tr');
    expect(row).not.toHaveClass('row--linked');
  });

  it('renders the RowLink as a real, keyboard-reachable link that is the row destination', () => {
    render(
      <MemoryRouter initialEntries={['/sources']}>
        <Routes>
          <Route
            path="/sources"
            element={
              <Table caption="Sources">
                <tbody>
                  <TableRow to="/sources/abc">
                    <td>
                      <RowLink to="/sources/abc">Contracts</RowLink>
                    </td>
                    <td>Active</td>
                  </TableRow>
                </tbody>
              </Table>
            }
          />
          <Route path="/sources/abc" element={<p>Source detail probe</p>} />
        </Routes>
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Contracts' });
    expect(link).toHaveAttribute('href', '/sources/abc');

    link.focus();
    expect(link).toHaveFocus();

    fireEvent.click(link);
    expect(screen.getByText('Source detail probe')).toBeInTheDocument();
  });

  it('activates the row destination on a plain click elsewhere in the row', () => {
    render(
      <MemoryRouter initialEntries={['/sources']}>
        <Routes>
          <Route
            path="/sources"
            element={
              <Table caption="Sources">
                <tbody>
                  <TableRow to="/sources/abc">
                    <td>
                      <RowLink to="/sources/abc">Contracts</RowLink>
                    </td>
                    <td>Active</td>
                  </TableRow>
                </tbody>
              </Table>
            }
          />
          <Route path="/sources/abc" element={<p>Source detail probe</p>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Active'));

    expect(screen.getByText('Source detail probe')).toBeInTheDocument();
  });

  it('does not navigate when the row click lands on another interactive control', () => {
    render(
      <MemoryRouter initialEntries={['/sources']}>
        <Routes>
          <Route
            path="/sources"
            element={
              <Table caption="Sources">
                <tbody>
                  <TableRow to="/sources/abc">
                    <td>
                      <RowLink to="/sources/abc">Contracts</RowLink>
                    </td>
                    <td>
                      <button type="button">Sync now</button>
                    </td>
                  </TableRow>
                </tbody>
              </Table>
            }
          />
          <Route path="/sources/abc" element={<p>Source detail probe</p>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    expect(screen.queryByText('Source detail probe')).not.toBeInTheDocument();
  });
});
