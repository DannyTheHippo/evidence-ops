import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import Table, { RowLink, TableCell, TableHeaderCell, TableRow } from './Table';

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

  it('renders a TableCell with its column label as data-label, and without one when no label is given', () => {
    render(
      <Table caption="Sources">
        <tbody>
          <tr>
            <TableCell label="Name">Contracts</TableCell>
            <TableCell>No label</TableCell>
          </tr>
        </tbody>
      </Table>,
    );

    expect(screen.getByText('Contracts')).toHaveAttribute('data-label', 'Name');
    expect(screen.getByText('No label')).not.toHaveAttribute('data-label');
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

  it('adds row--selected when selected is true, and omits it otherwise', () => {
    const { rerender } = render(
      <MemoryRouter>
        <Table caption="Sources">
          <tbody>
            <TableRow selected>
              <td>Contracts</td>
            </TableRow>
          </tbody>
        </Table>
      </MemoryRouter>,
    );

    expect(screen.getByText('Contracts').closest('tr')).toHaveClass('row--selected');

    rerender(
      <MemoryRouter>
        <Table caption="Sources">
          <tbody>
            <TableRow selected={false}>
              <td>Contracts</td>
            </TableRow>
          </tbody>
        </Table>
      </MemoryRouter>,
    );

    expect(screen.getByText('Contracts').closest('tr')).not.toHaveClass('row--selected');
  });

  it('combines row--selected with row--linked and a caller className', () => {
    render(
      <MemoryRouter>
        <Table caption="Sources">
          <tbody>
            <TableRow to="/sources/abc" selected className="highlight">
              <td>Contracts</td>
            </TableRow>
          </tbody>
        </Table>
      </MemoryRouter>,
    );

    const row = screen.getByText('Contracts').closest('tr');
    expect(row).toHaveClass('row--linked', 'row--selected', 'highlight');
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
