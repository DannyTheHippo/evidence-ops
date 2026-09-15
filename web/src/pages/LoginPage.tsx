import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { login, register } from '../api/client';
import AuthCanvas from '../components/AuthCanvas';
import Alert from '../components/ui/Alert';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import LinkButton from '../components/ui/LinkButton';
import PasswordInput from '../components/ui/PasswordInput';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../components/ui/PasswordRules';
import { announce } from '../lib/announce';
import { useFormSubmit } from '../lib/use-form-submit';
import { resolveReturnTo } from '../lib/return-to';
import { useSession } from '../lib/use-session';

type Mode = 'login' | 'signup';
type Field = 'email' | 'password';

// A cheap client-side format check only — the server is the real authority on what counts as a
// valid email, and rejects anything this lets through.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CredentialsFormProps {
  mode: Mode;
  email: string;
  onEmailChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  /** Where a successful submit navigates to; computed once by the caller so the sign-in flow and
   * the "already signed in" notice always agree on the same destination. */
  returnTo: string;
}

/**
 * The email/password fields and their submit lifecycle, keyed on `mode` by its caller so
 * switching between sign-in and account creation always starts `useFormSubmit` fresh — no stale
 * error or touched field survives the toggle. Email and password values live in the parent
 * instead, so a value already typed survives the same toggle.
 */
function CredentialsForm({
  mode,
  email,
  onEmailChange,
  password,
  onPasswordChange,
  returnTo,
}: CredentialsFormProps) {
  const navigate = useNavigate();
  const passwordMet =
    password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
  // Tracks the previous render's `passwordMet` so the announcement fires only on the transition
  // to met, not on every keystroke once the rule is already satisfied.
  const wasMetRef = useRef(passwordMet);

  useEffect(() => {
    if (mode === 'signup' && passwordMet && !wasMetRef.current) {
      announce(`${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters — met`);
    }
    wasMetRef.current = passwordMet;
  }, [mode, passwordMet]);

  function validate(): Partial<Record<Field, string>> {
    const errors: Partial<Record<Field, string>> = {};
    const trimmed = email.trim();
    if (!trimmed) errors.email = 'Email is required.';
    else if (!EMAIL_PATTERN.test(trimmed)) errors.email = 'Enter a valid email address.';

    if (!password) {
      errors.password = 'Password is required.';
    } else if (
      // Length is a signup-only constraint — refusing to attempt a sign-in because the stored
      // password happens to be short would reject a credential the server itself accepts.
      mode === 'signup' &&
      (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH)
    ) {
      errors.password = `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters.`;
    }
    return errors;
  }

  async function submit() {
    const trimmed = email.trim();
    if (mode === 'signup') await register(trimmed, password);
    await login(trimmed, password);
    await navigate(returnTo);
  }

  const { pending, formError, cooldownSeconds, onSubmit, fieldProps } = useFormSubmit<Field>({
    validate,
    submit,
  });

  return (
    <>
      {formError && <Alert tone="rejected">{formError}</Alert>}
      <form onSubmit={onSubmit} className="form" noValidate>
        <Input
          {...fieldProps('email')}
          label="Email"
          type="email"
          value={email}
          onChange={onEmailChange}
          autoComplete="email"
        />
        <PasswordInput
          {...fieldProps('password')}
          label="Password"
          value={password}
          onChange={onPasswordChange}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          hint={
            mode === 'signup'
              ? `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters${passwordMet ? ' — met' : ''}`
              : undefined
          }
        />
        <Button
          type="submit"
          variant="primary"
          className="auth-submit"
          busy={pending}
          busyLabel={mode === 'login' ? 'Signing in…' : 'Creating workspace…'}
          aria-disabled={cooldownSeconds > 0}
        >
          {mode === 'login' ? 'Sign in' : 'Create workspace'}
        </Button>
        {cooldownSeconds > 0 && (
          <span className="field-hint">
            Try again in {cooldownSeconds} second{cooldownSeconds === 1 ? '' : 's'}.
          </span>
        )}
      </form>
    </>
  );
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const location = useLocation();
  const session = useSession();
  const returnTo = resolveReturnTo(location.search);

  function toggleMode() {
    setMode((current) => (current === 'login' ? 'signup' : 'login'));
    // Scheduled for the next frame, matching useFormSubmit's own scheduleFocus: the title text
    // only reflects the new mode once this render commits.
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  return (
    <AuthCanvas
      title={mode === 'login' ? 'Sign in' : 'Create a new workspace'}
      description={
        mode === 'signup'
          ? "This creates a new, separate workspace with you as its admin. Joining a colleague's workspace happens through their invitation link, not here."
          : undefined
      }
      ref={headingRef}
      footer={
        <Button type="button" variant="ghost" onClick={toggleMode}>
          {mode === 'login'
            ? 'Need a workspace? Create a new workspace'
            : 'Have an account? Sign in'}
        </Button>
      }
    >
      {session.status === 'authed' && (
        <Alert
          tone="info"
          action={
            <LinkButton to={returnTo} variant="secondary" size="sm">
              Continue
            </LinkButton>
          }
        >
          You&apos;re already signed in.
        </Alert>
      )}
      <CredentialsForm
        key={mode}
        mode={mode}
        email={email}
        onEmailChange={setEmail}
        password={password}
        onPasswordChange={setPassword}
        returnTo={returnTo}
      />
    </AuthCanvas>
  );
}
