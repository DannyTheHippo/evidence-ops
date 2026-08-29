import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { InvitationPreview } from '../api/client';
import { ApiError, login, previewInvitation, registerWithInvitation } from '../api/client';
import AuthCanvas from '../components/AuthCanvas';
import Button from '../components/ui/Button';
import PasswordInput from '../components/ui/PasswordInput';
import PasswordRules, {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../components/ui/PasswordRules';
import { useFormSubmit } from '../lib/use-form-submit';

type Field = 'password';

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
  // Set only when redemption itself is refused — an unknown, expired, revoked, or already-used
  // token, or an invitation whose email already has an account — as distinct from a transport
  // failure or a login rejection right after a successful redemption. This is what a retry of the
  // same form can never fix, so it drives hiding the form in favor of the two paths that can:
  // a fresh link, or signing in.
  const [invitationRejected, setInvitationRejected] = useState(false);
  // Who is inviting and to what role, fetched before the form renders so accepting is an informed
  // decision rather than a blind one. Absent while the fetch is pending, and stays absent (falling
  // into the invitationRejected recovery path instead) if it fails — see the effect below.
  const [preview, setPreview] = useState<InvitationPreview | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    previewInvitation(token)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        // A preview failure means the token is unusable, same as a rejected redemption — folding it
        // into that same recovery path is what keeps the visitor off a blank or stuck form.
        if (!cancelled) setInvitationRejected(true);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  function validate(): Partial<Record<Field, string>> {
    const errors: Partial<Record<Field, string>> = {};
    if (!password) {
      errors.password = 'Password is required.';
    } else if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      errors.password = `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters.`;
    }
    return errors;
  }

  async function submit() {
    let me;
    try {
      me = await registerWithInvitation(password, token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setInvitationRejected(true);
      throw err;
    }
    // Registration sets no session cookie — a real login call is still required, mirroring
    // LoginPage's own signup path.
    await login(me.email, password);
    await navigate('/');
  }

  const { pending, formError, onSubmit, fieldProps } = useFormSubmit<Field>({
    validate,
    submit,
  });

  if (!token) {
    return (
      <AuthCanvas
        title="Missing invitation link"
        footer={
          <p>
            Already have an account? <Link to="/login">Sign in</Link>.
          </p>
        }
      >
        <p className="error" role="alert">
          This invitation link is missing its token. Ask whoever invited you for a new link.
        </p>
      </AuthCanvas>
    );
  }

  const inviteSummary = preview
    ? preview.invitedBy
      ? `${preview.invitedBy} invited you to join as ${preview.role}. Set a password to accept.`
      : `You've been invited to join as ${preview.role}. Set a password to accept.`
    : 'Set a password to accept the invitation and sign in.';

  return (
    <AuthCanvas title="Join your team" description={inviteSummary}>
      {formError && (
        <p className="error" role="alert">
          {formError}
        </p>
      )}
      {invitationRejected ? (
        // A rejected redemption is not something resubmitting the same form can fix, so the form
        // is gone and only the two paths that can help remain: a fresh link, or signing in.
        <p>
          Ask whoever invited you for a new link, or <Link to="/login">sign in</Link> if you already
          have an account.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="form" noValidate>
          <div className="field">
            <PasswordInput
              {...fieldProps('password')}
              label="Password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
            />
            <PasswordRules password={password} />
          </div>
          <div className="form-actions">
            <Button type="submit" variant="primary">
              {pending ? 'Joining…' : 'Accept invitation'}
            </Button>
          </div>
        </form>
      )}
    </AuthCanvas>
  );
}
