import type { FormEvent } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, register } from '../api/client';

type Mode = 'login' | 'signup';

export default function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (mode === 'signup') {
        await register(email, password);
      }
      await login(email, password);
      await navigate('/');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Create account'}</span>
          <h1 className="page-title">Evidence Ops</h1>
          <p className="page-sub">
            {mode === 'login' ? 'Sign in to your account.' : 'Sign up to get started.'}
          </p>
        </div>
      </div>

      <section className="card card--narrow">
        <form onSubmit={(e) => void handleSubmit(e)} className="form">
          <label>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={loading}>
              {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Sign up'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setMode((m) => (m === 'login' ? 'signup' : 'login'));
                setError(null);
              }}
            >
              {mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
            </button>
          </div>
        </form>
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
