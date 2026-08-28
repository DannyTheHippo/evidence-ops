import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, login, registerWithInvitation } from '../api/client';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import PasswordRules from '../components/ui/PasswordRules';

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
  // Set only when redemption itself is refused — an unknown, expired, revoked, or already-used
  // token, or an invitation whose email already has an account — as distinct from a transport
  // failure or a login rejection right after a successful redemption. This is what a retry of the
  // same form can never fix, so it drives hiding the form in favor of the two paths that can:
  // a fresh link, or signing in.
  const [invitationRejected, setInvitationRejected] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setInvitationRejected(false);

    let me;
    try {
      me = await registerWithInvitation(password, token);
    } catch (err: unknown) {
      setLoading(false);
      setInvitationRejected(err instanceof ApiError && err.status === 400);
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not reach the server. Check your connection and try again.',
      );
      return;
    }

    try {
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
      <div className="view">
        <div className="page-head">
          <div>
            <span className="eyebrow">You're invited</span>
            <h1 className="page-title">Missing invitation link</h1>
          </div>
        </div>
        <p className="error error--page" role="alert">
          This invitation link is missing its token. Ask whoever invited you for a new link.
        </p>
        <p className="page-sub">
          Already have an account? <Link to="/login">Sign in</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">You're invited</span>
          <h1 className="page-title">Join your team</h1>
          <p className="page-sub">Set a password to accept the invitation and sign in.</p>
        </div>
      </div>

      {!invitationRejected && (
        <section className="card card--narrow">
          <form onSubmit={(e) => void handleSubmit(e)} className="form">
            <div className="field">
              <Input
                label="Password"
                type="password"
                required
                minLength={8}
                maxLength={72}
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
              />
              <PasswordRules password={password} />
            </div>
            <div className="form-actions">
              <Button type="submit" variant="primary" disabled={loading}>
                {loading ? 'Joining…' : 'Accept invitation'}
              </Button>
            </div>
          </form>
        </section>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {invitationRejected && (
        <p className="page-sub">
          Ask whoever invited you for a new link, or <Link to="/login">sign in</Link> if you already
          have an account.
        </p>
      )}
    </div>
  );
}
