import type { FormEvent } from 'react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, login, registerWithInvitation } from '../api/client';
import Button from '../components/ui/Button';
import Field from '../components/ui/Field';

// The invitation, not this form, dictates the account's email, tenant and role — only a password
// is collected here. `token` comes from the link an admin shared out of band; there is no email
// step because there is nothing here to send it.
//
// The token lives in the URL fragment, not the query string: a fragment is never sent to the
// server, so nginx's access log (and any proxy in front of it) never sees this bearer credential.
export default function InvitePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const me = await registerWithInvitation(password, token);
      // Registration sets no session cookie — a real login call is still required, mirroring
      // LoginPage's own signup path.
      await login(me.email, password);
      await navigate('/');
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="view view--flow">
        <p className="error error--page" role="alert">
          This invitation link is missing its token. Ask whoever invited you for a new link.
        </p>
      </div>
    );
  }

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">You're invited</span>
          <h1 className="page-title">Join your team</h1>
          <p className="page-sub">Set a password to accept the invitation and sign in.</p>
        </div>
      </div>

      <section className="card card--narrow">
        <form onSubmit={(e) => void handleSubmit(e)} className="form">
          <Field label="Password">
            {(inputProps) => (
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                {...inputProps}
              />
            )}
          </Field>
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={loading}>
              {loading ? 'Joining…' : 'Accept invitation'}
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
