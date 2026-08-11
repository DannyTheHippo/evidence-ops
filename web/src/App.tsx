import type { ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { logout } from './api/client';
import { getToken } from './lib/auth';
import ApprovalsPage from './pages/ApprovalsPage';
import AskPage from './pages/AskPage';
import ConflictsPage from './pages/ConflictsPage';
import DataRoomPage from './pages/DataRoomPage';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import WorkflowRunPage from './pages/WorkflowRunPage';

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? 'topnav-link is-active' : 'topnav-link';
}

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
          <nav className="topnav">
            <NavLink to="/" end className={navLinkClassName}>
              Home
            </NavLink>
            <NavLink to="/documents" className={navLinkClassName}>
              Data Room
            </NavLink>
            <NavLink to="/ask" className={navLinkClassName}>
              Ask
            </NavLink>
            <NavLink to="/conflicts" className={navLinkClassName}>
              Conflicts
            </NavLink>
            <NavLink to="/approvals" className={navLinkClassName}>
              Approvals
            </NavLink>
          </nav>
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
          <Route
            path="/documents"
            element={
              <RequireAuth>
                <DataRoomPage />
              </RequireAuth>
            }
          />
          <Route
            path="/documents/:id"
            element={
              <RequireAuth>
                <DataRoomPage />
              </RequireAuth>
            }
          />
          <Route
            path="/ask"
            element={
              <RequireAuth>
                <AskPage />
              </RequireAuth>
            }
          />
          <Route
            path="/conflicts"
            element={
              <RequireAuth>
                <ConflictsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/approvals"
            element={
              <RequireAuth>
                <ApprovalsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/workflow-runs/:id"
            element={
              <RequireAuth>
                <WorkflowRunPage />
              </RequireAuth>
            }
          />
        </Routes>
      </main>
    </>
  );
}
