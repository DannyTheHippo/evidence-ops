import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { logout } from './api/client';
import { getToken } from './lib/auth';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';

function RequireAuth({ children }: { children: ReactNode }) {
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  const isAuthenticated = !!getToken();

  return (
    <>
      {isAuthenticated && (
        <header className="topbar">
          <span className="brand">
            <span className="brand-mark" aria-hidden />
            Evidence Ops
          </span>
          <span className="topbar-spacer" />
          <button className="btn btn--ghost btn--sm" onClick={handleLogout}>
            Logout
          </button>
        </header>
      )}
      <main className="container">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <HomePage />
              </RequireAuth>
            }
          />
        </Routes>
      </main>
    </>
  );
}
