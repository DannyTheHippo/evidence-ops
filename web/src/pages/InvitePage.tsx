import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { InvitationPreview, Me } from '../api/client';
import { ApiError, login, previewInvitation, registerWithInvitation } from '../api/client';
import AuthCanvas from '../components/AuthCanvas';
import Alert from '../components/ui/Alert';
import Button from '../components/ui/Button';
import PasswordInput from '../components/ui/PasswordInput';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../components/ui/PasswordRules';
import { announce } from '../lib/announce';
import { resolveReturnTo } from '../lib/return-to';
import { useFormSubmit } from '../lib/use-form-submit';

type Field = 'password';

// Which way out of a refused redemption the page offers. `ask-for-link` covers a token that was
// never usable from this browser, so only a fresh one helps. `sign-in` covers a token this
// browser's own earlier attempt may have spent — the account exists and signing in is the way in.
type Recovery = 'ask-for-link' | 'sign-in';

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
  const returnTo = resolveReturnTo(location.search);
  const [password, setPassword] = useState('');
  // Set only when redemption itself is refused — an unknown, expired, revoked, or already-used
  // token, or an invitation whose email already has an account — as distinct from a preview
  // transport failure or a login rejection right after a successful redemption. This is what a
  // retry of the same form can never fix, so it drives hiding the form in favor of the two paths
  // that can: a fresh link, or signing in.
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  // Who is inviting and to what role, fetched before the form renders so accepting is an informed
  // decision rather than a blind one. Absent while the fetch is pending, and stays absent if it is
  // refused outright (a 400 — the token itself is unusable).
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  // Set for a preview failure a retry can fix — a transport error or a 429 — as distinct from a
  // 400, which means the token itself is unusable and hides the form instead.
  const [previewRetryError, setPreviewRetryError] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  // Holds the account a successful registerWithInvitation call returned, so a retry after a failed
  // follow-up login signs in instead of redeeming the single-use token a second time.
  const redeemedRef = useRef<Me | null>(null);
  // Set once a redemption call has failed, whatever the reason. A refusal on a later attempt is
  // then read as this browser having spent the token already: the server answers a spent token
  // with the same 400 it gives an unknown one, so a refusal that arrives only after an attempt
  // that could have reached the server is the sole signal that an account is waiting.
  const redemptionFailedRef = useRef(false);
  // Set for the same 400 that drives `recovery === 'sign-in'`. That path already states its own
  // explanation ("Your account was created — sign in."), so the server's verbatim message would
  // otherwise render as a form-level alert contradicting it; `mapServerError` reads this to
  // suppress that alert without touching the first-attempt case, which keeps it.
  const spentTokenRetryRef = useRef(false);
  const recoveryRef = useRef<HTMLParagraphElement>(null);

  const passwordMet =
    password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
  // Tracks the previous render's `passwordMet` so the announcement fires only on the transition to
  // met, not on every keystroke once the rule is already satisfied.
  const wasMetRef = useRef(passwordMet);

  useEffect(() => {
    if (passwordMet && !wasMetRef.current) {
      announce(`${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters — met`);
    }
    wasMetRef.current = passwordMet;
  }, [passwordMet]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    // Each attempt's own outcome owns the retry message: a success clears it, a retryable failure
    // writes it, and `retryPreview` clears it as it starts the next attempt.
    previewInvitation(token)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setPreviewRetryError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 400) {
          setRecovery('ask-for-link');
        } else {
          setPreviewRetryError(err instanceof Error ? err.message : 'Something went wrong.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token, previewAttempt]);

  // The form's own region only ever holds a password field, which already carries focus from the
  // browser's own tab order; the recovery text has no control to receive it otherwise, so it would
  // fall to <body> without this.
  useEffect(() => {
    if (recovery) {
      requestAnimationFrame(() => recoveryRef.current?.focus());
    }
  }, [recovery]);

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
    let me = redeemedRef.current;
    if (!me) {
      const priorFailure = redemptionFailedRef.current;
      try {
        me = await registerWithInvitation(password, token);
      } catch (err) {
        if (err instanceof ApiError && err.status === 400) {
          spentTokenRetryRef.current = priorFailure;
          setRecovery(priorFailure ? 'sign-in' : 'ask-for-link');
        }
        redemptionFailedRef.current = true;
        throw err;
      }
      redeemedRef.current = me;
    }
    // Registration sets no session cookie — a real login call is still required, mirroring
    // LoginPage's own signup path.
    await login(me.email, password);
    await navigate(returnTo);
  }

  const { pending, formError, cooldownSeconds, onSubmit, fieldProps } = useFormSubmit<Field>({
    validate,
    submit,
    mapServerError(err) {
      return err.status === 400 && spentTokenRetryRef.current ? {} : null;
    },
  });

  function retryPreview() {
    setPreviewRetryError(null);
    setPreviewAttempt((n) => n + 1);
  }

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
        <Alert tone="rejected">
          This invitation link is missing its token. Ask whoever invited you for a new link.
        </Alert>
      </AuthCanvas>
    );
  }

  const inviteSummary = preview
    ? preview.invitedBy
      ? `${preview.invitedBy} invited ${preview.email} to join as ${preview.role}.`
      : `${preview.email} was invited to join as ${preview.role}.`
    : 'Set a password to accept the invitation and sign in.';

  return (
    <AuthCanvas title="Join your team" description={inviteSummary}>
      {previewRetryError && (
        <Alert
          tone="rejected"
          action={
            <Button variant="secondary" size="sm" onClick={retryPreview}>
              Retry
            </Button>
          }
        >
          {previewRetryError}
        </Alert>
      )}
      {formError && <Alert tone="rejected">{formError}</Alert>}
      {recovery ? (
        // A rejected redemption is not something resubmitting the same form can fix, so the form
        // is gone and only the two paths that can help remain: a fresh link, or signing in. The
        // path this refusal points at leads and the other trails it as a fallback, since a token
        // the server calls unusable reads the same whether or not an account came out of it.
        <p ref={recoveryRef} tabIndex={-1}>
          {recovery === 'sign-in' ? (
            <>
              Your account was created — <Link to="/login">sign in</Link>. If that does not work,
              ask whoever invited you for a new link.
            </>
          ) : (
            <>
              Ask whoever invited you for a new link, or <Link to="/login">sign in</Link> if you
              already have an account.
            </>
          )}
        </p>
      ) : (
        <form onSubmit={onSubmit} className="form" noValidate>
          <PasswordInput
            {...fieldProps('password')}
            label="Password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            hint={`${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters${passwordMet ? ' — met' : ''}`}
          />
          <Button
            type="submit"
            variant="primary"
            className="auth-submit"
            busy={pending}
            busyLabel="Joining…"
            aria-disabled={cooldownSeconds > 0}
          >
            Accept invitation
          </Button>
          {cooldownSeconds > 0 && (
            <span className="field-hint">
              Try again in {cooldownSeconds} second{cooldownSeconds === 1 ? '' : 's'}.
            </span>
          )}
        </form>
      )}
    </AuthCanvas>
  );
}
