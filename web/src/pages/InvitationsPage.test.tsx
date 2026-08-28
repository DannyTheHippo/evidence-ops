import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import InvitationsPage from './InvitationsPage';

describe('InvitationsPage', () => {
  it('redirects to /people, keeping an existing link or bookmark working', () => {
    render(
      <MemoryRouter initialEntries={['/invitations']}>
        <Routes>
          <Route path="/invitations" element={<InvitationsPage />} />
          <Route path="/people" element={<p>people probe</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('people probe')).toBeInTheDocument();
  });
});
