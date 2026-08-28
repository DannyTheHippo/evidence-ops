import type { FormEvent } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login, register } from '../api/client';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import PasswordRules from '../components/ui/PasswordRules';

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
      // `login`/`register` throw `ApiError` and nothing else: the client converts a transport
      // failure and an unreadable body into one before either reaches here. Its message is
      // therefore always presentable, whether it names an invalid credential or an unreachable
      // server, and never a raw browser exception string.
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Create account'}</span>
          <h1 className="page-title">Evidence Ops</h1>
          <p className="page-sub">
            {mode === 'login' ? 'Sign in to your account.' : 'Create an account to get started.'}
          </p>
        </div>
      </div>

      <section className="card card--narrow">
        <form onSubmit={(e) => void handleSubmit(e)} className="form">
          <Input
            label="Email"
            type="email"
            required
            value={email}
            onChange={setEmail}
            autoComplete="email"
          />
          <div className="field">
            <Input
              label="Password"
              type="password"
              required
              minLength={8}
              maxLength={72}
              value={password}
              onChange={setPassword}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            {mode === 'signup' && <PasswordRules password={password} />}
          </div>
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={loading}>
              {loading
                ? mode === 'login'
                  ? 'Signing in…'
                  : 'Creating account…'
                : mode === 'login'
                  ? 'Sign in'
                  : 'Create account'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setMode((m) => (m === 'login' ? 'signup' : 'login'));
                setError(null);
              }}
            >
              {mode === 'login' ? 'Need an account? Create one' : 'Have an account? Sign in'}
            </Button>
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
