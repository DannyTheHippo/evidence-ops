import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Table, { TableHeaderCell } from './Table';

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
});
